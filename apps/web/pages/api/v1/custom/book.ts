import { compare } from "bcryptjs";
import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError, z } from "zod";

import handleNewBookingInternal from "@calcom/features/bookings/lib/handleNewBooking";
import { HttpError } from "@calcom/lib/http-error";
import prisma from "@calcom/prisma";
import { CreationSource } from "@calcom/prisma/enums";

// Define a more specific type for the expected structure of a failed booking result
interface FailedBookingResult {
  message?: string;
  status?: number;
  statusCode?: number;
  // Include other properties if known
}

// Assuming CalComBookingResponse is the type for a SUCCESSFUL booking
// This type might need to be defined more concretely based on what handleNewBookingInternal actually returns.
// For now, we'll assume it has a 'uid' on success.
interface CalComBookingResponse {
  uid?: string;
  // Add other success properties
}

const bookApiSchema = z.object({
  externalUserIdOfHost: z.string().min(1),
  eventTypeId: z.number().int().positive(),
  startDateTime: z.string().datetime(),
  endDateTime: z.string().datetime(),
  timeZone: z.string(),
  attendeeName: z.string().min(1),
  attendeePhoneNumber: z.string().min(1),
  attendeeEmail: z.string().email().optional(),
  metadata: z.record(z.unknown()).optional(), // Changed z.any() to z.unknown() for stricter parsing
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed` });
  }

  const applicationIdFromHeader = req.headers["x-application-id"] as string;
  const applicationApiKeyFromHeader = req.headers["x-application-api-key"] as string;

  if (!applicationIdFromHeader || !applicationApiKeyFromHeader) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Missing x-application-id or x-application-api-key header.",
    });
  }

  try {
    const authorizedApp = await prisma.authorizedApplication.findUnique({
      where: { applicationId: applicationIdFromHeader },
    });

    if (!authorizedApp || !authorizedApp.isActive) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Application '${applicationIdFromHeader}' is not authorized or not active.`,
      });
    }

    const isKeyValid = await compare(applicationApiKeyFromHeader, authorizedApp.apiKeyHash);
    if (!isKeyValid) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: Invalid x-application-api-key." });
    }

    const validationResult = bookApiSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw validationResult.error;
    }

    const {
      externalUserIdOfHost,
      eventTypeId,
      startDateTime,
      endDateTime,
      timeZone,
      attendeeName,
      attendeePhoneNumber,
      attendeeEmail,
      metadata,
    } = validationResult.data;

    const mapping = await prisma.applicationUserMapping.findUnique({
      where: {
        externalUserId_identityProviderName_applicationId: {
          externalUserId: externalUserIdOfHost,
          identityProviderName: "supabase_auth",
          applicationId: applicationIdFromHeader,
        },
      },
      select: { calComUserId: true },
    });

    if (!mapping || !mapping.calComUserId) {
      throw new HttpError({
        statusCode: 404,
        message: `Host user (externalId: ${externalUserIdOfHost}) not provisioned for application: ${applicationIdFromHeader}`,
      });
    }
    const calComUserIdOfHost = mapping.calComUserId;

    const eventTypeFromDb = await prisma.eventType.findUnique({
      where: { id: eventTypeId },
      include: {
        owner: {
          select: { id: true, username: true, email: true, name: true, timeZone: true, locale: true },
        },
      },
    });

    if (!eventTypeFromDb) {
      throw new HttpError({ statusCode: 404, message: `EventType with ID ${eventTypeId} not found.` });
    }

    const hostUser = eventTypeFromDb.owner;
    if (!hostUser || hostUser.id !== calComUserIdOfHost || !hostUser.username) {
      throw new HttpError({
        statusCode: 403,
        message: `EventType ${eventTypeId} is not managed by the specified host user.`,
      });
    }

    const bookerEmailForCalCom =
      attendeeEmail || `phone.${attendeePhoneNumber.replace(/\D/g, "")}@internal.cal.com`;

    const bookingDataForCalCom = {
      start: startDateTime,
      end: endDateTime,
      eventTypeId: eventTypeFromDb.id,
      eventTypeSlug: eventTypeFromDb.slug,
      timeZone: timeZone,
      user: hostUser.username,
      name: attendeeName,
      email: bookerEmailForCalCom,
      notes: "",
      metadata: metadata || {},
      guests: [],
      language: hostUser.locale || "en",
      creationSource: CreationSource.API_V2,
      responses: {
        name: attendeeName,
        email: bookerEmailForCalCom,
      },
    };

    // The result from handleNewBookingInternal can be complex.
    // We cast it to 'unknown' first to force proper type checking.
    const resultFromInternal = await handleNewBookingInternal({
      bookingData: bookingDataForCalCom,
      userId: undefined,
    });
    const result = resultFromInternal as CalComBookingResponse | FailedBookingResult;

    if (result && typeof result === "object" && "uid" in result && result.uid) {
      return res.status(201).json({
        success: true,
        message: "Booking successful.",
        calComBookingId: result.uid,
      });
    } else {
      console.error("[book.ts] Booking creation problematic or failed. Cal.com internal response:", result);
      let internalMessage = "Booking failed within Cal.com's internal processing.";
      let internalStatus = 500;

      if (result && typeof result === "object") {
        const errorResponse = result as FailedBookingResult;
        internalMessage = errorResponse.message || internalMessage;
        if (typeof errorResponse.status === "number") {
          internalStatus = errorResponse.status;
        } else if (typeof errorResponse.statusCode === "number") {
          internalStatus = errorResponse.statusCode;
        }
      }
      return res
        .status(internalStatus)
        .json({ success: false, message: internalMessage, calComResponse: result });
    }
  } catch (error: unknown) {
    let logMessage = "An unexpected error occurred during booking.";

    if (error instanceof Error) {
      logMessage = error.message;
      console.error(
        `[API] /custom/book POST - Error for applicationId: ${applicationIdFromHeader}:`,
        logMessage,
        error.stack
      );
    } else {
      console.error(
        `[API] /custom/book POST - Non-Error object caught for applicationId: ${applicationIdFromHeader}:`,
        error
      );
    }

    if (error instanceof HttpError) {
      const errorDetails = error.cause instanceof ZodError ? error.cause.format() : error.cause;
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        errors: errorDetails,
      });
    }

    if (error instanceof ZodError) {
      return res.status(400).json({
        success: false,
        message: "Invalid request body.",
        errors: error.format(),
      });
    }

    return res.status(500).json({ success: false, message: "Internal server error while creating booking." });
  }
}
