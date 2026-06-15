import { getServiceConfig } from "./client.js";
import { logger } from "../config/logger.js";

const SERVICE_TIMEOUT_MS = 8_000;

async function postToNinjaTask<T>(
  path: string,
  clerkId: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  const config = getServiceConfig("NINJA_TASK");
  if (!config) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);

  try {
    const res = await fetch(`${config.url}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Ninja-Task-Clerk-Id": clerkId,
        "X-Ninja-Service": "ninja-planner",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn({ path, status: res.status }, "[ninja-task] POST failed");
      return null;
    }

    return await res.json() as T;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logger.warn({ path }, "[ninja-task] POST timed out");
    } else {
      logger.warn({ path, err }, "[ninja-task] POST error");
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a quest in ninja-task for a specific user (identified by Clerk ID).
 * ninja-task quests schema: title, description, theme, taskIds, bonusXP.
 * No dueDate column exists — do not pass it.
 */
export async function createQuestInNinjaTask(params: {
  title: string;
  description?: string | null;
  clerkId: string;
}): Promise<{ id: string } | null> {
  return postToNinjaTask<{ id: string }>(
    "/api/quests",
    params.clerkId,
    {
      title: params.title,
      description: params.description ?? null,
      theme: "work",
      bonusXP: 100,
    },
  );
}

/**
 * Capture an item to the ninja-task GTD inbox for a specific user.
 * GTD capture endpoint only accepts: title.
 */
export async function captureToNinjaTaskGtd(params: {
  title: string;
  clerkId: string;
}): Promise<{ id: string } | null> {
  return postToNinjaTask<{ id: string }>(
    "/api/gtd/capture",
    params.clerkId,
    {
      title: params.title,
    },
  );
}

/**
 * Push a task to ninja-task for a specific user.
 */
export async function pushTaskToNinjaTask(params: {
  title: string;
  description?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  tags?: string[];
  clerkId: string;
}): Promise<{ id: string } | null> {
  return postToNinjaTask<{ id: string }>(
    "/api/tasks",
    params.clerkId,
    {
      title: params.title,
      description: params.description ?? null,
      priority: params.priority === "urgent" ? "high" : (params.priority ?? "medium"),
      dueDate: params.dueDate ?? null,
      tags: params.tags ?? [],
      xpValue: 20,
    },
  );
}

/**
 * Fetch a user's ninja-task profile by their Clerk ID.
 */
export async function getNinjaTaskProfile(clerkId: string): Promise<{
  level: number;
  xp: number;
  coins: number;
  username: string | null;
  longestStreak: number;
} | null> {
  const config = getServiceConfig("NINJA_TASK");
  if (!config) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${config.url}/api/profile/public?clerkId=${encodeURIComponent(clerkId)}`,
      {
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "X-Ninja-Service": "ninja-planner",
        },
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      logger.warn({ clerkId, status: res.status }, "[ninja-task] profile fetch failed");
      return null;
    }

    return await res.json() as {
      level: number;
      xp: number;
      coins: number;
      username: string | null;
      longestStreak: number;
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logger.warn({ clerkId }, "[ninja-task] profile fetch timed out");
    } else {
      logger.warn({ clerkId, err }, "[ninja-task] profile fetch error");
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
