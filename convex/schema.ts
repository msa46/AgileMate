import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Store standup users who have opted in
  standupUsers: defineTable({
    userId: v.string(),
    guildId: v.string(),
    channelId: v.string(),
    joinedAt: v.number(), // timestamp
  }).index("by_guild_and_user", ["guildId", "userId"])
    .index("by_guild", ["guildId"]),
  
  // Store daily standup responses
  standupResponses: defineTable({
    userId: v.string(),
    guildId: v.string(),
    date: v.string(), // YYYY-MM-DD format
    done: v.string(),
    doing: v.string(),
    blockers: v.string(),
    submittedAt: v.number(), // timestamp
  }).index("by_guild_and_date", ["guildId", "date"])
    .index("by_user_and_date", ["userId", "date"])
    .index("by_guild_user_date", ["guildId", "userId", "date"]),
});