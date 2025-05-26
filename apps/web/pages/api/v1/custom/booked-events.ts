import type { NextApiResponse } from "next";
import { z, ZodError } from "zod";

// Added ZodError import
import prisma from "@calcom/prisma";

import { withAuth, type NextApiRequestWithAuthContext } from "./_lib/authMiddleware";

// Uses your latest authMiddleware

// Zod schema for optional query parameters (e.g., for date range filtering)
const bookedEventsQuerySchema = z.object({
  startDate: z
    .string()
    .datetime({ message: "Invalid startDate format, expected ISO 8601 datetime string" })
    .optional(),
  endDate: z
    .string()
    .datetime({ message: "Invalid endDate format, expected ISO 8601 datetime string" })
    .optional(),
  // You could add other filters like status: z.enum(["CONFIRMED", "CANCELLED", "PENDING"]).optional(),
});

async function handler(req: NextApiRequestWithAuthContext, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
  }

  const authContext = req.authContext; // Get authContext once

  // Perform all necessary checks on authContext with early returns
  if (!authContext) {
    return res.status(401).json({ message: "Authentication context is missing." });
  }
  if (!authContext.externalUserId) {
    return res.status(401).json({ message: "Authentication context is missing externalUserId." });
  }
  if (!authContext.applicationId) {
    return res.status(400).json({ message: "Application context (application_id) is missing in token." });
  }

  // If we reach here, TypeScript knows authContext and its properties are defined.
  const { externalUserId, identityProviderName, applicationId } = authContext;

  try {
    // Validate query parameters
    const queryValidation = bookedEventsQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      throw queryValidation.error; // Throw ZodError to be caught below
    }
    const { startDate, endDate } = queryValidation.data;

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
      // Consider throwing HttpError for consistency if you have a central error handler
      return res
        .status(403)
        .json({ message: `User not provisioned or not authorized for application: ${applicationId}` });
    }
    // calComUserId is assigned once and its value is known here
    const calComUserId = mapping.calComUserId;

    // --- Step 2: Construct the where clause for fetching bookings ---
    const whereClause: {
      // Explicitly typing whereClause
      userId: number;
      startTime?: { gte?: Date; lt?: Date };
      // status?: string; // Example if you were to add status filter
    } = {
      userId: calComUserId, // Bookings for this specific Cal.com user profile
      // status: 'CONFIRMED', // Example: only fetch confirmed bookings
    };

    if (startDate) {
      whereClause.startTime = { ...whereClause.startTime, gte: new Date(startDate) };
    }
    if (endDate) {
      whereClause.startTime = { ...whereClause.startTime, lt: new Date(endDate) };
    }

    // --- Step 3: Fetch bookings from the database ---
    const bookings = await prisma.booking.findMany({
      where: whereClause,
      include: {
        attendees: {
          select: {
            name: true,
            email: true,
            timeZone: true,
          },
        },
        eventType: {
          select: {
            id: true,
            title: true,
            length: true,
          },
        },
        user: {
          // This is the Cal.com user who is the host/organizer of the event
          select: {
            id: true,
            username: true,
            name: true,
            email: true,
          },
        },
        // Consider including 'references' for calendar event UIDs or video call links
        // references: { select: { type: true, uid: true, meetingUrl: true, externalCalendarId: true } },
      },
      orderBy: {
        startTime: "asc",
      },
    });

    // --- Step 4: Format the bookings for the response ---
    const formattedBookings = bookings.map((booking) => ({
      calComBookingId: booking.id,
      title: booking.title || booking.eventType?.title || "Scheduled Meeting",
      startTime: booking.startTime,
      endTime: booking.endTime,
      status: booking.status,
      description: booking.description,
      metadata: booking.metadata, // This was added in a previous step
      // uid: booking.uid, // Main UID for the booking
      organizerCalComUser: booking.user
        ? {
            id: booking.user.id,
            username: booking.user.username,
            name: booking.user.name,
            email: booking.user.email,
          }
        : null,
      attendees: booking.attendees.map((att) => ({
        name: att.name,
        email: att.email,
        timeZone: att.timeZone,
      })),
      eventTypeId: booking.eventTypeId,
      eventType: booking.eventType
        ? {
            id: booking.eventType.id,
            title: booking.eventType.title,
            length: booking.eventType.length,
          }
        : null,
      // Add custom inputs or metadata if relevant and stored
      // customInputs: booking.customInputs,
      // references: booking.references, // If you included references
    }));

    return res.status(200).json(formattedBookings);
  } catch (error: unknown) {
    // Changed from 'any' to 'unknown'
    let consoleErrorMessage: string;
    let consoleErrorStack: string | undefined;

    if (error instanceof Error) {
      consoleErrorMessage = error.message;
      consoleErrorStack = error.stack;
    } else {
      consoleErrorMessage = "An unexpected non-Error object was caught.";
    }

    console.error(
      `[API] /custom/booked-events GET - Error for externalUserId: ${externalUserId}, IdP: ${identityProviderName}, applicationId: ${applicationId}: ${consoleErrorMessage}`,
      consoleErrorStack || error // Log stack if available, otherwise the raw error
    );

    if (error instanceof ZodError) {
      // Check for ZodError first
      return res.status(400).json({ message: "Invalid query parameters.", errors: error.format() });
    }
    // If you start throwing HttpErrors from the try block, you'd add a check here:
    // if (error instanceof HttpError) {
    //   const errorDetails = error.cause instanceof ZodError ? error.cause.format() : error.cause;
    //   return res.status(error.statusCode).json({ message: error.message, details: errorDetails });
    // }

    return res.status(500).json({ message: "Internal server error while fetching booked events." });
  }
}

export default withAuth(handler);
