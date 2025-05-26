import { compare } from "bcryptjs";
import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError, z } from "zod";

import prisma from "@calcom/prisma";

// If you have a custom HttpError, ensure it's imported. If not, you might handle errors differently.
// import { HttpError } from "@calcom/lib/http-error";

const disableUserSchema = z.object({
  externalUserId: z.string({ required_error: "externalUserId is required" }).min(1),
});

// Make sure there are no unusual characters or comments immediately before this line
export default async function handler(
  req: NextApiRequest, // Using the standard type
  res: NextApiResponse // Using the standard type
) {
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

    const validationResult = disableUserSchema.safeParse(req.body);
    if (!validationResult.success) {
      throw validationResult.error; // Caught by ZodError handler
    }

    const { externalUserId } = validationResult.data;
    const identityProviderName = "supabase_auth"; // Assuming this remains constant for now

    // Attempt to find and delete the mapping
    // Using try/catch for the delete operation to handle cases where the mapping might not exist
    // Prisma's delete operation throws an error if the record to be deleted is not found.
    try {
      const deletedMapping = await prisma.applicationUserMapping.delete({
        where: {
          externalUserId_identityProviderName_applicationId: {
            externalUserId,
            identityProviderName,
            applicationId: applicationIdFromHeader,
          },
        },
      });

      return res.status(200).json({
        success: true,
        message: `User (externalUserId: ${externalUserId}) has been successfully disabled for application '${applicationIdFromHeader}'. Cal.com user ID ${deletedMapping.calComUserId} is unmapped.`,
      });
    } catch (deleteError: unknown) {
      // Check if the error is a Prisma known request error and has the specific code
      if (
        deleteError &&
        typeof deleteError === "object" &&
        "code" in deleteError &&
        deleteError.code === "P2025"
      ) {
        return res.status(404).json({
          success: false,
          message: `User mapping not found for externalUserId '${externalUserId}' and application '${applicationIdFromHeader}'. No action taken.`,
        });
      }
      // Re-throw other unexpected errors from the delete operation
      throw deleteError;
    }
  } catch (error: unknown) {
    let logMessage = "An unexpected error occurred during user disabling.";
    let errorStack: string | undefined;

    if (error instanceof Error) {
      logMessage = error.message;
      errorStack = error.stack;
      console.error(
        `[API] /custom/internal/disable-user POST - Error for applicationId: ${applicationIdFromHeader}:`,
        logMessage,
        errorStack
      );
    } else {
      console.error(
        `[API] /custom/internal/disable-user POST - Non-Error object caught for applicationId: ${applicationIdFromHeader}:`,
        error
      );
    }

    if (error instanceof ZodError) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid request body.", errors: error.format() });
    }

    // General fallback
    return res.status(500).json({ success: false, message: "Internal server error during user disabling." });
  }
}
