import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import session from "express-session";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { users, ROLES, TRIP_STATUS } from "@shared/schema";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import pgSession from "connect-pg-simple";
import { pool } from "./db";

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [salt, key] = stored.split(":");
  const derivedKey = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(key, "hex"), derivedKey);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // === AUTH SETUP ===
  const PgSession = pgSession(session);
  
  app.use(
    session({
      store: new PgSession({
        pool,
        tableName: 'session'
      }),
      secret: process.env.SESSION_SECRET || "dev_secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        secure: app.get("env") === "production",
      },
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        const user = await storage.getUserByUsername(username);
        if (!user) return done(null, false, { message: "Incorrect username." });
        
        const isValid = await comparePasswords(password, user.password);
        if (!isValid) return done(null, false, { message: "Incorrect password." });
        
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );

  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (err) {
      done(err);
    }
  });

  // === SEED DATA ===
  // Create default admin if not exists
  const existingAdmin = await storage.getUserByUsername('admin');
  if (!existingAdmin) {
    const hashedPassword = await hashPassword('admin123');
    await storage.createUser({
      username: 'admin',
      password: hashedPassword,
      name: 'System Admin',
      role: ROLES.ADMIN
    });
    console.log('Created default admin user');
  }

  // === API ROUTES ===

  // Auth
  app.post(api.auth.login.path, passport.authenticate("local"), (req, res) => {
    res.json(req.user);
  });

  app.post(api.auth.logout.path, (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get(api.auth.me.path, (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    res.json(req.user);
  });

  // Middleware to check auth
  const requireAuth = (req: any, res: any, next: any) => {
    if (req.isAuthenticated()) return next();
    res.sendStatus(401);
  };

  const requireAdmin = (req: any, res: any, next: any) => {
    if (req.isAuthenticated() && req.user.role === ROLES.ADMIN) return next();
    res.sendStatus(403);
  };

  // Trips
  app.get(api.trips.list.path, requireAuth, async (req, res) => {
    const query = api.trips.list.input.optional().parse(req.query);
    const filters = {
      vehicleNumber: query?.vehicleNumber,
      tripId: query?.tripId,
      loadedAfter: query?.loadedAfter ? new Date(query.loadedAfter) : undefined,
      settled: query?.settled === 'true' ? true : query?.settled === 'false' ? false : undefined,
    };
    const trips = await storage.getTrips(filters);
    res.json(trips);
  });

  app.get(api.trips.get.path, requireAuth, async (req, res) => {
    const trip = await storage.getTrip(Number(req.params.id));
    if (!trip) return res.sendStatus(404);
    res.json(trip);
  });

  app.post(api.trips.create.path, requireAuth, async (req, res) => {
    try {
      const input = api.trips.create.input.parse(req.body);
      
      // Auto-generate ID: YYYY_COUNT
      const year = new Date().getFullYear();
      const count = (await storage.getTrips()).length + 1;
      const tripId = `${year}_${count}`;

      // Calculate balances
      const motorOwnerBalance = (Number(input.motorOwnerBhada || 0) - Number(input.motorOwnerAdvance || 0)).toString();
      const partyBalance = (Number(input.partyFreight || 0) - Number(input.partyAdvance || 0)).toString();

      const trip = await storage.createTrip({
        ...input,
        tripId,
        motorOwnerBalance,
        partyBalance
      });
      res.status(201).json(trip);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.put(api.trips.update.path, requireAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const input = api.trips.update.input.parse(req.body);
      
      const existingTrip = await storage.getTrip(id);
      if (!existingTrip) return res.sendStatus(404);

      // Rule: Managers CANNOT edit completed/settled trips
      if (req.user.role !== ROLES.ADMIN && 
          (existingTrip.status === TRIP_STATUS.COMPLETED || existingTrip.status === TRIP_STATUS.SETTLED)) {
        return res.status(403).json({ message: "Managers cannot edit completed or settled trips." });
      }

      // Rule: Managers CANNOT edit bhada (if it's being updated)
      if (req.user.role !== ROLES.ADMIN && input.motorOwnerBhada !== undefined) {
         return res.status(403).json({ message: "Managers cannot edit Bhada." });
      }

      // Re-calculate balances if financials change
      let motorOwnerBalance = existingTrip.motorOwnerBalance;
      if (input.motorOwnerBhada || input.motorOwnerAdvance) {
        const bhada = input.motorOwnerBhada ?? existingTrip.motorOwnerBhada;
        const advance = input.motorOwnerAdvance ?? existingTrip.motorOwnerAdvance;
        motorOwnerBalance = (Number(bhada || 0) - Number(advance || 0)).toString();
      }

      let partyBalance = existingTrip.partyBalance;
      if (input.partyFreight || input.partyAdvance) {
        const freight = input.partyFreight ?? existingTrip.partyFreight;
        const advance = input.partyAdvance ?? existingTrip.partyAdvance;
        partyBalance = (Number(freight || 0) - Number(advance || 0)).toString();
      }

      const trip = await storage.updateTrip(id, {
        ...input,
        motorOwnerBalance,
        partyBalance
      });
      res.json(trip);
    } catch (err) {
      if (err instanceof z.ZodError) {
         return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  // Analytics
  app.get(api.analytics.dashboard.path, requireAdmin, async (req, res) => {
    const stats = await storage.getDashboardStats();
    res.json(stats);
  });

  app.get(api.analytics.parties.path, requireAdmin, async (req, res) => {
    const stats = await storage.getPartyAnalytics();
    res.json(stats);
  });

  app.get(api.analytics.motorOwners.path, requireAdmin, async (req, res) => {
    const stats = await storage.getMotorOwnerAnalytics();
    res.json(stats);
  });

  // Users (Admin only)
  app.post(api.users.create.path, requireAdmin, async (req, res) => {
    try {
      const input = api.users.create.input.parse(req.body);
      
      // Check if user already exists
      const existingUser = await storage.getUserByUsername(input.username);
      if (existingUser) {
        return res.status(400).json({ message: "Username already exists", field: "username" });
      }

      const hashedPassword = await hashPassword(input.password);
      const user = await storage.createUser({
        ...input,
        password: hashedPassword
      });
      res.status(201).json(user);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  return httpServer;
}
