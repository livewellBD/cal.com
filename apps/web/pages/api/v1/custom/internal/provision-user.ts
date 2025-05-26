// [File: pages/api/v1/custom/internal/provision-user.ts]
// Prisma type for Cal.com User
// Import Prisma error types for specific error handling
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { compare } from "bcryptjs";
import { customAlphabet } from "nanoid";
import type { NextApiRequest, NextApiResponse } from "next";
import slugify from "slugify";
import { ZodError, z } from "zod";

// Your local Prisma client for ApplicationUserMapping etc.
import { HttpError } from "@calcom/lib/http-error";
import prisma from "@calcom/prisma";

// Zod schema for validating the incoming request body.
// defaultEventTypes is removed as per the simplified plan.
const provisionUserSchema = z.object({
  externalUserId: z.string({ required_error: "externalUserId is required" }).min(1),
  name: z.string({ required_error: "name is required" }).min(1),
  email: z.string({ required_error: "email is required" }).email(),
  timeZone: z.string().optional().default("America/New_York"), // Default, can be overridden by request
});

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

// Base URL for your self-hosted Cal.com V2 API
// Ensure this is correctly pointing to your Cal.com instance.
// For local development, if this API route is part of the SAME Cal.com instance,
// it would be localhost. If Cal.com is hosted elsewhere, update accordingly.
const CALCOM_API_V2_BASE_URL = process.env.NEXT_PUBLIC_WEBAPP_URL || "http://localhost:3000";
const CALCOM_V2_API_KEY = process.env.CALCOM_V2_API_KEY;

// Interface for the expected successful response from Cal.com V2 POST /users or GET /users?email=...
// Adjust based on the actual V2 API response structure.
interface CalComV2UserResponse {
  id: number;
  username: string | null; // Username can be null
  email: string;
  name: string | null;
  // Add other fields you might need from the V2 user object
}

// Interface for the expected error response from Cal.com V2 API (e.g., 409 Conflict)
interface CalComV2ErrorResponse {
  message: string;
  error?: unknown; // Or more specific type if known
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed` });
  }

  // --- Application-Specific API Key Authentication (Your Custom Layer) ---
  const applicationIdFromHeader = req.headers["x-application-id"] as string;
  const applicationApiKeyFromHeader = req.headers["x-application-api-key"] as string;

  if (!applicationIdFromHeader || !applicationApiKeyFromHeader) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: Missing x-application-id or x-application-api-key header.",
    });
  }

  if (!CALCOM_V2_API_KEY) {
    console.error("CRITICAL: CALCOM_V2_API_KEY is not set in environment variables.");
    return res
      .status(500)
      .json({ success: false, message: "Configuration error: Cal.com V2 API key not configured." });
  }

  // This variable will hold the externalUserId for logging in the catch block
  let attemptedExternalUserIdForLogging = "unknown";

  try {
    // Authenticate the calling application (your custom logic)
    const authorizedApp = await prisma.authorizedApplication.findUnique({
      where: { applicationId: applicationIdFromHeader },
    });

    if (!authorizedApp || !authorizedApp.isActive) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Application '${applicationIdFromHeader}' is not authorized or not active.`,
      });
    }

    const isAppKeyValid = await compare(applicationApiKeyFromHeader, authorizedApp.apiKeyHash);
    if (!isAppKeyValid) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: Invalid x-application-api-key." });
    }

    // Validate the incoming request body for your custom API
    const validationResult = provisionUserSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw validationResult.error; // Let ZodError handler in catch block handle this
    }

    const { externalUserId, name, email, timeZone } = validationResult.data;
    attemptedExternalUserIdForLogging = externalUserId; // Set for logging if error occurs later
    const identityProviderName = "supabase_auth"; // As per current architecture

    // Start a Prisma transaction for your local database operations
    const result = await prisma.$transaction(async (tx) => {
      // 1. Check if this externalUserId is already mapped to this applicationId in your DB
      const existingMapping = await tx.applicationUserMapping.findUnique({
        where: {
          externalUserId_identityProviderName_applicationId: {
            externalUserId,
            identityProviderName,
            applicationId: applicationIdFromHeader,
          },
        },
      });

      if (existingMapping) {
        throw new HttpError({
          statusCode: 409,
          message: `Conflict: This externalUserId ('${externalUserId}') is already provisioned and mapped for applicationId '${applicationIdFromHeader}'.`,
        });
      }

      // 2. Find or Create Cal.com User via V2 API
      let calComUserV2: CalComV2UserResponse | null = null;
      let newUserWasCreatedInCalCom = false;
      let relinkedExistingCalComUser = false;

      // Prepare headers for Cal.com V2 API calls
      const v2ApiHeaders = {
        "Content-Type": "application/json",
        "X-API-KEY": CALCOM_V2_API_KEY, // Or "Authorization": `Bearer ${CALCOM_V2_API_KEY}` if that's what Cal.com V2 uses
      };

      // Attempt to create the user via Cal.com V2 API
      // A unique username might be required by Cal.com V2 API or it might auto-generate one.
      // For simplicity, let's try to generate one. Cal.com might adjust or error if not unique.
      const baseSlug = slugify(name, { lower: true, strict: true });
      const initialUsernameAttempt = `${baseSlug}-${nanoid()}`; // This might need more robust uniqueness handling

      const createUserPayload = {
        email,
        name,
        username: initialUsernameAttempt, // Cal.com V2 API might handle uniqueness or error out
        timeZone,
        // Add other fields as required/supported by POST /v2/users
      };

      console.log("Calling POST /v2/users with payload:", JSON.stringify(createUserPayload, null, 2));
      console.log("Calling POST /v2/users with headers:", JSON.stringify(v2ApiHeaders, null, 2));

      const createUserResponse = await fetch(`${CALCOM_API_V2_BASE_URL}/api/v2/users`, {
        method: "POST",
        headers: v2ApiHeaders,
        body: JSON.stringify(createUserPayload),
      });

      if (createUserResponse.ok) {
        // Status 200-299, typically 201 for POST
        calComUserV2 = (await createUserResponse.json()) as CalComV2UserResponse;
        newUserWasCreatedInCalCom = true;
      } else if (createUserResponse.status === 409) {
        // Conflict, likely email already exists
        console.log(`User with email ${email} already exists in Cal.com. Fetching existing user.`);
        const getUsersResponse = await fetch(
          `${CALCOM_API_V2_BASE_URL}/api/v2/users?email=${encodeURIComponent(email)}`,
          {
            method: "GET",
            headers: v2ApiHeaders,
          }
        );
        if (getUsersResponse.ok) {
          const usersArray = (await getUsersResponse.json()) as CalComV2UserResponse[];
          if (usersArray.length > 0) {
            calComUserV2 = usersArray[0];
            relinkedExistingCalComUser = true;
          } else {
            // This case is unlikely if POST /users returned 409 for email, but handle defensively
            throw new Error(
              `Cal.com V2 API: User with email ${email} reported as existing (409), but not found via GET /users?email.`
            );
          }
        } else {
          const errorBody = await getUsersResponse.text();
          throw new Error(
            `Cal.com V2 API: Failed to fetch existing user by email ${email}. Status: ${getUsersResponse.status}. Body: ${errorBody}`
          );
        }
      } else {
        // Handle other errors from POST /v2/users
        const errorBody = await createUserResponse.text();
        throw new Error(
          `Cal.com V2 API: Failed to create user. Status: ${createUserResponse.status}. Body: ${errorBody}`
        );
      }

      // Ensure we have a Cal.com user at this point
      if (!calComUserV2 || typeof calComUserV2.id !== "number") {
        throw new Error("Failed to obtain a valid Cal.com user ID from V2 API.");
      }

      // 3. Create the ApplicationUserMapping in your local DB
      // This uses the calComUserV2.id obtained from the V2 API.
      await tx.applicationUserMapping.create({
        data: {
          externalUserId,
          identityProviderName,
          applicationId: applicationIdFromHeader,
          calComUserId: calComUserV2.id,
        },
      });

      // Since we are not creating default schedules/event types here anymore,
      // provisionedEventTypes will be an empty array.
      return {
        calComUserId: calComUserV2.id,
        username: calComUserV2.username, // This comes from Cal.com V2 response
        provisionedEventTypes: [], // No event types created by this API anymore
        relinkedExistingCalComUser,
        newUserWasCreatedInCalCom,
      };
    }); // End of Prisma Transaction

    // Construct the success response based on whether a new user was created or an existing one was re-linked
    return res.status(201).json({
      success: true,
      message: result.newUserWasCreatedInCalCom
        ? "New Cal.com user created via V2 API and mapped successfully."
        : "Existing Cal.com user found via V2 API and re-linked to application successfully.",
      calComUserId: result.calComUserId,
      username: result.username,
      // provisionedEventTypes: result.provisionedEventTypes, // This is now always empty
      relinkedExistingCalComUser: result.relinkedExistingCalComUser,
      newUserWasCreatedInCalCom: result.newUserWasCreatedInCalCom,
    });
  } catch (error: unknown) {
    let logMessage = "An unexpected error occurred during user provisioning.";
    let errorStack: string | undefined;

    if (error instanceof Error) {
      logMessage = error.message;
      errorStack = error.stack;
      console.error(
        `[API] /custom/internal/provision-user POST - Error for applicationId: ${applicationIdFromHeader}, externalUserId: ${attemptedExternalUserIdForLogging}:`,
        logMessage,
        errorStack
      );

      // Check for Prisma specific known request errors (e.g., for ApplicationUserMapping unique constraint)
      if (error instanceof PrismaClientKnownRequestError) {
        if (error.code === "P2002") {
          let conflictMessage = "A unique constraint violation occurred in local mapping.";
          const targetFields = error.meta?.target;
          if (
            Array.isArray(targetFields) &&
            targetFields.join("_").toLowerCase().includes("applicationusermapping")
          ) {
            conflictMessage = `Conflict: This externalUserId ('${attemptedExternalUserIdForLogging}') is already provisioned for application '${applicationIdFromHeader}'.`;
          } else if (
            typeof targetFields === "string" &&
            targetFields.toLowerCase().includes("applicationusermapping")
          ) {
            conflictMessage = `Conflict: This externalUserId ('${attemptedExternalUserIdForLogging}') is already provisioned for application '${applicationIdFromHeader}'.`;
          }
          return res.status(409).json({
            success: false,
            message: conflictMessage,
            details: targetFields,
          });
        }
      }
    } else {
      console.error(
        `[API] /custom/internal/provision-user POST - Non-Error object caught for applicationId: ${applicationIdFromHeader}, externalUserId: ${attemptedExternalUserIdForLogging}:`,
        error
      );
    }

    // Handle HttpError (e.g., from our explicit check for existing ApplicationUserMapping)
    if (error instanceof HttpError) {
      const errorDetails = error.cause instanceof ZodError ? error.cause.format() : error.cause;
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message, details: errorDetails });
    }

    // Handle ZodError from request body validation
    if (error instanceof ZodError) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request body.", errors: error.format() });
    }

    // Fallback for other unhandled errors (including those from fetch calls to Cal.com V2 API)
    return res.status(500).json({ success: false, message: logMessage }); // Return the caught error message
  }
}
