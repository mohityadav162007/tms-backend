import { db } from "./db";
import {
  users, trips,
  type User, type InsertUser,
  type Trip, type InsertTrip,
  type DashboardStats, type PartyAnalytics, type MotorOwnerAnalytics,
  TRIP_STATUS
} from "@shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";

export interface IStorage {
  // Auth
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Trips
  getTrips(filters?: {
    vehicleNumber?: string;
    tripId?: string;
    loadedAfter?: Date;
    settled?: boolean;
  }): Promise<Trip[]>;
  getTrip(id: number): Promise<Trip | undefined>;
  createTrip(trip: InsertTrip & { tripId: string }): Promise<Trip>;
  updateTrip(id: number, trip: Partial<InsertTrip>): Promise<Trip>;
  
  // Analytics
  getDashboardStats(): Promise<DashboardStats>;
  getPartyAnalytics(): Promise<PartyAnalytics>;
  getMotorOwnerAnalytics(): Promise<MotorOwnerAnalytics>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [newUser] = await db.insert(users).values(user).returning();
    return newUser;
  }

  async getTrips(filters?: {
    vehicleNumber?: string;
    tripId?: string;
    loadedAfter?: Date;
    settled?: boolean;
  }): Promise<Trip[]> {
    let conditions = [];
    
    if (filters?.vehicleNumber) {
      conditions.push(sql`${trips.vehicleNumber} ILIKE ${`%${filters.vehicleNumber}%`}`);
    }
    
    if (filters?.tripId) {
      conditions.push(sql`${trips.tripId} ILIKE ${`%${filters.tripId}%`}`);
    }
    
    if (filters?.loadedAfter) {
      conditions.push(gte(trips.loadingDate, filters.loadedAfter.toISOString()));
    }
    
    if (filters?.settled === true) {
      conditions.push(eq(trips.status, TRIP_STATUS.SETTLED));
    } else if (filters?.settled === false) {
      conditions.push(sql`${trips.status} != ${TRIP_STATUS.SETTLED}`);
    }

    return await db.select()
      .from(trips)
      .where(and(...conditions))
      .orderBy(desc(trips.loadingDate));
  }

  async getTrip(id: number): Promise<Trip | undefined> {
    const [trip] = await db.select().from(trips).where(eq(trips.id, id));
    return trip;
  }

  async createTrip(trip: InsertTrip & { tripId: string }): Promise<Trip> {
    const [newTrip] = await db.insert(trips).values(trip).returning();
    return newTrip;
  }

  async updateTrip(id: number, trip: Partial<InsertTrip>): Promise<Trip> {
    const [updatedTrip] = await db.update(trips)
      .set(trip)
      .where(eq(trips.id, id))
      .returning();
    return updatedTrip;
  }

  async getDashboardStats(): Promise<DashboardStats> {
    // This would ideally be an optimized aggregation query
    // For now, fetching all and calculating to keep it simple with types
    const allTrips = await db.select().from(trips);
    
    const totalTrips = allTrips.length;
    const activeTrips = allTrips.filter(t => t.status !== TRIP_STATUS.COMPLETED && t.status !== TRIP_STATUS.SETTLED).length;
    
    const partyRevenue = allTrips.reduce((sum, t) => sum + Number(t.partyFreight || 0), 0);
    // Pending amount = Total Freight - Total Advance (Rough calc)
    const pendingAmount = allTrips.reduce((sum, t) => sum + (Number(t.partyBalance || 0)), 0);

    // Mock chart data for now
    const monthlyTrips = [
      { date: '2024-01', count: 12 },
      { date: '2024-02', count: 19 },
      { date: '2024-03', count: 15 },
    ];
    
    const revenueFlow = [
      { month: 'Jan', amount: 50000 },
      { month: 'Feb', amount: 75000 },
      { month: 'Mar', amount: 60000 },
    ];

    return {
      totalTrips,
      activeTrips,
      partyRevenue,
      pendingAmount,
      monthlyTrips,
      revenueFlow
    };
  }

  async getPartyAnalytics(): Promise<PartyAnalytics> {
    // Basic aggregation
    const result = await db.select({
      name: trips.partyName,
      totalTrips: sql<number>`count(*)`,
      totalFreight: sql<number>`sum(${trips.partyFreight})`,
      totalAdvance: sql<number>`sum(${trips.partyAdvance})`,
      outstandingBalance: sql<number>`sum(${trips.partyBalance})`,
    })
    .from(trips)
    .groupBy(trips.partyName);
    
    return result.map(r => ({
      name: r.name,
      totalTrips: Number(r.totalTrips),
      totalFreight: Number(r.totalFreight),
      totalAdvance: Number(r.totalAdvance),
      outstandingBalance: Number(r.outstandingBalance)
    }));
  }

  async getMotorOwnerAnalytics(): Promise<MotorOwnerAnalytics> {
     const result = await db.select({
      name: trips.motorOwnerName,
      tripsDone: sql<number>`count(*)`,
      totalBhada: sql<number>`sum(${trips.motorOwnerBhada})`,
      paid: sql<number>`sum(${trips.motorOwnerAdvance})`,
      balance: sql<number>`sum(${trips.motorOwnerBalance})`,
    })
    .from(trips)
    .where(eq(trips.vehicleType, 'MARKET'))
    .groupBy(trips.motorOwnerName);

    return result.map(r => ({
      name: r.name || 'Unknown',
      tripsDone: Number(r.tripsDone),
      totalBhada: Number(r.totalBhada),
      paid: Number(r.paid),
      balance: Number(r.balance)
    }));
  }
}

export const storage = new DatabaseStorage();
