import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// User Management Functions
export const addStandupUser = mutation({
  args: {
    userId: v.string(),
    guildId: v.string(),
    channelId: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if user already exists for this guild
    const existingUser = await ctx.db
      .query("standupUsers")
      .withIndex("by_guild_and_user", (q) => 
        q.eq("guildId", args.guildId).eq("userId", args.userId)
      )
      .first();
    
    if (existingUser) {
      // Update existing user's channel preference
      return ctx.db.patch(existingUser._id, {
        channelId: args.channelId,
      });
    } else {
      // Add new user
      return ctx.db.insert("standupUsers", {
        userId: args.userId,
        guildId: args.guildId,
        channelId: args.channelId,
        joinedAt: Date.now(),
      });
    }
  }
});

export const removeStandupUser = mutation({
  args: {
    userId: v.string(),
    guildId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("standupUsers")
      .withIndex("by_guild_and_user", (q) => 
        q.eq("guildId", args.guildId).eq("userId", args.userId)
      )
      .first();
    
    if (user) {
      await ctx.db.delete(user._id);
      return { success: true };
    } else {
      return { success: false, error: "User not found" };
    }
  }
});

export const getStandupUsers = query({
  args: {
    guildId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("standupUsers")
      .withIndex("by_guild", (q) => q.eq("guildId", args.guildId))
      .collect();
  }
});

export const getStandupUser = query({
  args: {
    userId: v.string(),
    guildId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("standupUsers")
      .withIndex("by_guild_and_user", (q) => 
        q.eq("guildId", args.guildId).eq("userId", args.userId)
      )
      .first();
  }
});

export const getAllGuildsWithStandups = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("standupUsers").collect();
    // Get unique guild IDs
    const guildIds = [...new Set(users.map(user => user.guildId))];
    return guildIds;
  }
});

// Response Management Functions
export const submitStandupResponse = mutation({
  args: {
    userId: v.string(),
    guildId: v.string(),
    date: v.string(),
    done: v.string(),
    doing: v.string(),
    blockers: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if response already exists for today
    const existingResponse = await ctx.db
      .query("standupResponses")
      .withIndex("by_guild_user_date", (q) => 
        q.eq("guildId", args.guildId)
          .eq("userId", args.userId)
          .eq("date", args.date)
      )
      .first();
    
    if (existingResponse) {
      // Update existing response
      return ctx.db.patch(existingResponse._id, {
        done: args.done,
        doing: args.doing,
        blockers: args.blockers,
        submittedAt: Date.now(),
      });
    } else {
      // Add new response
      return ctx.db.insert("standupResponses", {
        userId: args.userId,
        guildId: args.guildId,
        date: args.date,
        done: args.done,
        doing: args.doing,
        blockers: args.blockers,
        submittedAt: Date.now(),
      });
    }
  }
});

export const getStandupResponsesByDate = query({
  args: {
    guildId: v.string(),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("standupResponses")
      .withIndex("by_guild_and_date", (q) => 
        q.eq("guildId", args.guildId).eq("date", args.date)
      )
      .collect();
  }
});

export const getStandupResponseForUser = query({
  args: {
    userId: v.string(),
    guildId: v.string(),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("standupResponses")
      .withIndex("by_guild_user_date", (q) => 
        q.eq("guildId", args.guildId)
          .eq("userId", args.userId)
          .eq("date", args.date)
      )
      .first();
  }
});