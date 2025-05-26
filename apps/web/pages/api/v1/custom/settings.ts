import type { NextApiResponse } from "next";
import { z } from "zod";

// Uses your latest authMiddleware
import prisma from "@calcom/prisma";

import type { NextApiRequestWithAuthContext } from "./_lib/authMiddleware";
import { withAuth } from "./_lib/authMiddleware";

// Zod schema for validating the POST request body for basic settings updates
const updateUserSettingsSchema = z.object({
  name: z.string().min(1).optional(),
  timeZone: z.string().optional(),
  weekStart: z.string().optional(),
  timeFormat: z.number().int().min(12).max(24).optional(),
});

async function handler(req: NextApiRequestWithAuthContext, res: NextApiResponse) {
  const authContext = req.authContext;

  if (!authContext || !authContext.externalUserId) {
    return res.status(401).json({ message: "Authentication context is missing or invalid." });
  }

  if (!authContext.applicationId) {
    return res.status(400).json({ message: "Application context (application_id) is missing in token." });
  }

  const { externalUserId, identityProviderName, applicationId, email: userEmailFromJwt } = authContext;

  let calComUserId: number;

  try {
    // --- Step 1: Resolve calComUserId using externalUserId, identityProviderName, and applicationId ---
    const mapping = await prisma.applicationUserMapping.findUnique({
      where: {
        // This assumes your @@unique constraint in Prisma for ApplicationUserMapping
        // on (externalUserId, identityProviderName, applicationId)
        // will generate a default identifier like 'externalUserId_identityProviderName_applicationId'.
        // Adjust if you explicitly named your constraint in schema.prisma.
        externalUserId_identityProviderName_applicationId: {
          externalUserId: externalUserId,
          identityProviderName: identityProviderName, // Will be "supabase_auth" for now
          applicationId: applicationId,
        },
      },
      select: {
        calComUserId: true,
      },
    });

    if (!mapping || !mapping.calComUserId) {
      console.warn(
        `No Cal.com user mapping found for externalUserId: ${externalUserId}, IdP: ${identityProviderName}, applicationId: ${applicationId}`
      );
      return res
        .status(403)
        .json({ message: `User not provisioned or not authorized for application: ${applicationId}` });
    }
    calComUserId = mapping.calComUserId;

    // --- GET Request Handler ---
    if (req.method === "GET") {
      const calcomUser = await prisma.user.findUnique({
        where: { id: calComUserId },
        include: {
          schedules: {
            include: {
              availability: {
                select: {
                  id: true,
                  days: true,
                  startTime: true,
                  endTime: true,
                  userId: true,
                  scheduleId: true,
                  date: true,
                },
              },
            },
          },
        },
      });

      if (!calcomUser) {
        return res.status(404).json({
          message: `Cal.com user profile (ID: ${calComUserId}) not found for the given application context.`,
        });
      }

      const settings = {
        calComUserId: calcomUser.id,
        // For client reference, could include the context it was fetched for:
        // externalUserId: externalUserId,
        // identityProviderName: identityProviderName,
        // applicationId: applicationId,
        username: calcomUser.username,
        email: calcomUser.email, // Cal.com profile email
        name: calcomUser.name,
        timeZone: calcomUser.timeZone,
        weekStart: calcomUser.weekStart,
        timeFormat: calcomUser.timeFormat,
        hideBranding: calcomUser.hideBranding,
        schedules: calcomUser.schedules.map((schedule) => ({
          id: schedule.id,
          name: schedule.name,
          timeZone: schedule.timeZone,
          availability: schedule.availability.map((avail) => ({
            id: avail.id,
            days: avail.days,
            startTime: avail.startTime,
            endTime: avail.endTime,
          })),
        })),
      };
      return res.status(200).json(settings);
    }
    // --- POST Request Handler ---
    else if (req.method === "POST") {
      const validationResult = updateUserSettingsSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res
          .status(400)
          .json({ message: "Invalid request body", errors: validationResult.error.format() });
      }

      const dataToUpdate: {
        name?: string;
        timeZone?: string;
        weekStart?: string;
        timeFormat?: number;
      } = {};

      if (validationResult.data.name !== undefined) dataToUpdate.name = validationResult.data.name;
      if (validationResult.data.timeZone !== undefined)
        dataToUpdate.timeZone = validationResult.data.timeZone;
      if (validationResult.data.weekStart !== undefined)
        dataToUpdate.weekStart = validationResult.data.weekStart;
      if (validationResult.data.timeFormat !== undefined)
        dataToUpdate.timeFormat = validationResult.data.timeFormat;

      if (Object.keys(dataToUpdate).length === 0) {
        return res.status(400).json({ message: "No valid fields provided for update." });
      }

      const updatedUser = await prisma.user.update({
        where: { id: calComUserId },
        data: dataToUpdate,
      });

      const responseUpdatedFields: any = {};
      if (dataToUpdate.name !== undefined) responseUpdatedFields.name = updatedUser.name;
      if (dataToUpdate.timeZone !== undefined) responseUpdatedFields.timeZone = updatedUser.timeZone;
      if (dataToUpdate.weekStart !== undefined) responseUpdatedFields.weekStart = updatedUser.weekStart;
      if (dataToUpdate.timeFormat !== undefined) responseUpdatedFields.timeFormat = updatedUser.timeFormat;

      return res.status(200).json({
        message: "Settings updated successfully for the current application context.",
        updatedUser: responseUpdatedFields,
      });
    } else {
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }
  } catch (error) {
    console.error(
      `[API] /custom/settings ${req.method} - Error for externalUserId: ${externalUserId}, IdP: ${identityProviderName}, applicationId: ${applicationId}:`,
      error
    );
    return res.status(500).json({ message: "Internal server error." });
  }
}

export default withAuth(handler);
