/* eslint-disable prettier/prettier */
import type { NextApiResponse } from "next";
import { z, ZodError } from "zod";

import dayjs from "@calcom/dayjs";
// Cal.com's Dayjs instance
import { getUserAvailability } from "@calcom/lib/getUserAvailability";
import { HttpError } from "@calcom/lib/http-error";
import getSlots from "@calcom/lib/slots";
import type { GetSlotsParams } from "@calcom/lib/slots";
// Added ZodError import
import prisma from "@calcom/prisma";

// From your research on slots.ts
import { withAuth, type NextApiRequestWithAuthContext } from "./_lib/authMiddleware";

// Uses your latest authMiddleware

// Infer the input query type from the getUserAvailability function
type ActualGetUserAvailabilityQuery = Parameters<typeof getUserAvailability>[0];
// Infer the result type from getUserAvailability - this gives us the context, not final slots
type ActualGetAvailabilityContextResult = Awaited<ReturnType<typeof getUserAvailability>>;

const availableSlotsQuerySchema = z.object({
  eventTypeId: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((val) => !isNaN(val) && val > 0, { message: "eventTypeId must be a positive integer" }),
  startDate: z.string().datetime({ message: "startDate must be an ISO 8601 datetime string" }),
  endDate: z.string().datetime({ message: "endDate must be an ISO 8601 datetime string" }),
  timeZone: z.string().optional(), // IANA timezone string, e.g., "Europe/Berlin"
  duration: z
    .string()
    .transform((val) => parseInt(val, 10))
    .refine((val) => val > 0, { message: "duration must be a positive integer" })
    .optional(),
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
    return res.status(401).json({ message: "Authentication context is missing applicationId." });
  }

  // If we reach here, TypeScript knows authContext and its properties are defined.
  const { externalUserId, identityProviderName, applicationId } = authContext;

  try {
    const queryValidation = availableSlotsQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      throw queryValidation.error; // Throw ZodError to be caught below
    }
    const {
      eventTypeId,
      startDate,
      endDate,
      timeZone: queryTimeZone,
      duration: queryDuration,
    } = queryValidation.data;

    const mapping = await prisma.applicationUserMapping.findUnique({
      where: {
        externalUserId_identityProviderName_applicationId: {
          externalUserId,
          identityProviderName,
          applicationId,
        },
      },
      select: { calComUserId: true },
    });

    if (!mapping || !mapping.calComUserId) {
      // Consider throwing an HttpError for consistency if you have a central error handler
      // For now, direct return as in original code
      return res.status(403).json({ message: `User not provisioned for application: ${applicationId}` });
    }
    // calComUserId is only assigned once and its value comes directly from the mapping
    const calComUserId = mapping.calComUserId;

    // Fetch EventType with its scalar fields and owner relation
    const eventType = await prisma.eventType.findUnique({
      where: { id: eventTypeId },
      include: {
        // Only include relations
        owner: { select: { id: true, username: true, timeZone: true } },
      },
      // Scalar fields like length, beforeEventBuffer, afterEventBuffer, timeZone, slotInterval, minimumBookingNotice, offsetStart
      // are fetched by default because we are using 'include' and not a top-level 'select' for EventType.
    });

    if (!eventType) {
      throw new HttpError({ statusCode: 404, message: `EventType with ID ${eventTypeId} not found.` });
    }

    let targetUsernameForAvailability: string | null = null;
    let userDefaultTimeZoneForAvailability: string | null = eventType.timeZone; // EventType's own timezone is a good first default

    let initialEffectiveDuration: number | undefined = queryDuration; // Use a different variable name

    if (eventType.owner && eventType.owner.id === calComUserId && eventType.owner.username) {
      targetUsernameForAvailability = eventType.owner.username;
      if (eventType.owner.timeZone) userDefaultTimeZoneForAvailability = eventType.owner.timeZone;
    } else {
      const calComUser = await prisma.user.findUnique({
        where: { id: calComUserId },
        select: { username: true, timeZone: true },
      });
      if (calComUser && calComUser.username) {
        targetUsernameForAvailability = calComUser.username;
        if (calComUser.timeZone && !userDefaultTimeZoneForAvailability) {
          userDefaultTimeZoneForAvailability = calComUser.timeZone;
        }
      } else {
        throw new HttpError({
          statusCode: 404,
          message: `Cal.com user profile (ID: ${calComUserId}) could not be determined.`,
        });
      }
    }

    if (!targetUsernameForAvailability) {
      // This should ideally not be reached if prior checks are done correctly
      throw new HttpError({
        statusCode: 500,
        message: "Critical: Failed to determine target username for availability check.",
      });
    }

    const effectiveTimeZone = queryTimeZone || userDefaultTimeZoneForAvailability || "UTC";

    if (initialEffectiveDuration === undefined) {
      initialEffectiveDuration = eventType.length; // eventType.length is number
    }

    // This check ensures initialEffectiveDuration is a number or an error is thrown
    if (initialEffectiveDuration === null || initialEffectiveDuration === undefined) {
      throw new HttpError({
        statusCode: 400,
        message: "Event duration (length) is not defined for the event type and not provided in the query.",
      });
    }

    // At this point, initialEffectiveDuration is guaranteed to be a number.
    // Assign it to a new const to make its type explicit for the rest of the function.
    const finalEffectiveDuration: number = initialEffectiveDuration;

    // Construct query for getUserAvailability
    const availabilityContextQuery: ActualGetUserAvailabilityQuery = {
      username: targetUsernameForAvailability,
      eventTypeId: eventTypeId,
      dateFrom: startDate, // Pass as ISO string
      dateTo: endDate, // Pass as ISO string
      // timeZone is NOT passed here as getUserAvailability derives it.
      duration: finalEffectiveDuration, // Use the const with the explicit number type
      beforeEventBuffer: eventType.beforeEventBuffer || 0,
      afterEventBuffer: eventType.afterEventBuffer || 0,
      returnDateOverrides: false, // Required by internal Zod schema of getUserAvailability
      bypassBusyCalendarTimes: false,
      shouldServeCache: true,
    };

    // Step 1: Get available date ranges and busy context
    const availabilityContext = (await getUserAvailability(
      availabilityContextQuery
    )) as ActualGetAvailabilityContextResult; // This cast might need review if the return type isn't guaranteed

    if (!availabilityContext || !availabilityContext.dateRanges || !availabilityContext.timeZone) {
      console.error(
        "getUserAvailability did not return expected dateRanges or timeZone structure:",
        availabilityContext
      );
      throw new HttpError({
        statusCode: 500,
        message: "Failed to retrieve availability context from internal function.",
      });
    }

    // Step 2: Prepare parameters for getSlots
    const inviteeDateAsDayjs = dayjs(startDate).tz(effectiveTimeZone); // Use effectiveTimeZone for inviteeDate context
    const frequency = eventType.slotInterval || finalEffectiveDuration; // Use the const

    const getSlotsParams: GetSlotsParams = {
      inviteeDate: inviteeDateAsDayjs,
      frequency: frequency,
      minimumBookingNotice: eventType.minimumBookingNotice || 0,
      // Convert Date objects from availabilityContext.dateRanges to Dayjs objects in the correct timezone
      dateRanges: availabilityContext.dateRanges.map((dr) => ({
        start: dayjs(dr.start).tz(availabilityContext.timeZone), // Use timeZone from availabilityContext
        end: dayjs(dr.end).tz(availabilityContext.timeZone),
      })),
      eventLength: finalEffectiveDuration, // Use the const
      offsetStart: eventType.offsetStart || 0,
      datesOutOfOffice: availabilityContext.datesOutOfOffice,
    };

    // Step 3: Call getSlots to generate the final slot times
    const finalSlotsRaw = getSlots(getSlotsParams);

    // Step 4: Format the slots for the API response
    const formattedApiSlots = finalSlotsRaw
      .filter((slot) => !slot.away) // Filter out slots marked as 'away'
      .map((slot) => ({
        start: slot.time.toISOString(), // slot.time is a Dayjs object, convert to ISO string (UTC)
        // Now use finalEffectiveDuration, which TypeScript knows is a number
        end: slot.time.add(finalEffectiveDuration, "minutes").toISOString(),
      }));

    return res.status(200).json(formattedApiSlots);
  } catch (error: unknown) {
    let consoleMessage = "Internal server error while fetching available slots.";
    let consoleErrorStack: string | undefined;

    if (error instanceof Error) {
      consoleMessage = error.message;
      consoleErrorStack = error.stack;
    }

    console.error(
      `[API] /custom/available-slots GET - Error for externalUserId: ${externalUserId}, IdP: ${identityProviderName}, applicationId: ${applicationId}:`,
      consoleMessage,
      consoleErrorStack || error // Log stack if available, otherwise the raw error
    );

    if (error instanceof HttpError) {
      // HttpError.cause is 'unknown'. If it might be ZodError, format it.
      const errorDetails = error.cause instanceof ZodError ? error.cause.format() : error.cause;
      return res.status(error.statusCode).json({ message: error.message, details: errorDetails });
    }
    if (error instanceof ZodError) {
      return res.status(400).json({ message: "Invalid query parameters.", errors: error.format() });
    }
    // Fallback generic error response
    return res.status(500).json({ message: "Internal server error while fetching available slots." });
  }
}

export default withAuth(handler);
