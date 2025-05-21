import type { NextApiResponse } from "next";

// Ensure AuthenticatedUserPayload is exported or used internally in NextApiRequestWithUser
import prisma from "@calcom/prisma";

import type { NextApiRequestWithUser } from "./_lib/authMiddleware";
import { withAuth } from "./_lib/authMiddleware";

async function handler(req: NextApiRequestWithUser, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
  }

  const userPayload = req.user;

  if (!userPayload || !userPayload.email || !userPayload.sub) {
    return res.status(400).json({ message: "User email or ID not found in authentication token." });
  }

  const userEmail: string = userPayload.email;
  const supabaseUserId: string = userPayload.sub;

  try {
    const calcomUser = await prisma.user.findUnique({
      where: {
        email: userEmail,
      },
      include: {
        schedules: {
          include: {
            availability: {
              select: {
                id: true,
                days: true,
                startTime: true,
                endTime: true,
                userId: true, // Add any other scalar fields from the Availability model that you need
                scheduleId: true,
                date: true,
                // Do NOT include other relations here with 'true' if they exist,
                // be specific or omit if not needed.
              },
            },
          },
        },
      },
    });

    if (!calcomUser) {
      return res.status(404).json({ message: `Cal.com user with email ${userEmail} not found.` });
    }

    const settings = {
      calcomUserId: calcomUser.id,
      supabaseUserId: supabaseUserId,
      username: calcomUser.username,
      email: calcomUser.email,
      name: calcomUser.name,
      timeZone: calcomUser.timeZone, // User's global timezone
      weekStart: calcomUser.weekStart,
      timeFormat: calcomUser.timeFormat,
      hideBranding: calcomUser.hideBranding,
      schedules: calcomUser.schedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        timeZone: schedule.timeZone, // Direct access, assuming it's a string like "America/New_York"
        availability: schedule.availability.map((avail) => ({
          id: avail.id,
          days: avail.days,
          startTime: avail.startTime,
          endTime: avail.endTime,
        })),
      })),
    };

    return res.status(200).json(settings);
  } catch (error) {
    console.error("[API] /custom/settings - Error fetching user settings:", error);
    return res.status(500).json({ message: "Internal server error while fetching settings." });
  }
}

export default withAuth(handler);
