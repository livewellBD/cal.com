import type { JwtPayload } from "jsonwebtoken";
import { verify } from "jsonwebtoken";
import type { NextApiRequest, NextApiResponse, NextApiHandler } from "next";

/**
 * Defines the structure of the JWT payload we expect.
 * For Supabase, 'sub' is the user ID. We'll map this to externalUserId.
 * Custom claims like app_metadata for application_id are also expected.
 */
export interface AuthenticatedUserJwtPayload extends JwtPayload {
  sub: string; // Standard JWT subject claim (maps to externalUserId for Supabase)
  email?: string;
  app_metadata?: {
    application_id?: string; // Our custom claim for identifying the application context
  };
  // Add any other standard or custom claims you expect (e.g., role, or 'iss' for issuer)
}

/**
 * Defines the structure of the authentication context object
 * that will be attached to the request object after successful authentication.
 */
export interface AuthenticatedContext {
  externalUserId: string; // The user's ID from the identity provider
  identityProviderName: string; // Name of the identity provider (e.g., "supabase_auth")
  applicationId: string | null; // The application context ID, null if not present
  email?: string; // User's email, if available from token
}

/**
 * Extends NextApiRequest to include our custom authContext.
 */
export interface NextApiRequestWithAuthContext extends NextApiRequest {
  authContext?: AuthenticatedContext;
}

// Constant for the current identity provider
const CURRENT_IDENTITY_PROVIDER_NAME = "supabase_auth";

/**
 * Higher-order function to protect API routes.
 * Verifies the JWT and extracts user, identity provider, and application context.
 * @param handler The NextApiHandler to wrap.
 * @returns An authenticated NextApiHandler.
 */
export const withAuth = (handler: NextApiHandler) => {
  return async (req: NextApiRequestWithAuthContext, res: NextApiResponse) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized: Missing or malformed token." });
    }

    const token = authHeader.split(" ")[1];
    // For now, we assume a single JWT secret (Supabase).
    // If supporting multiple IdPs, this secret retrieval would need to be dynamic based on token issuer.
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;

    if (!jwtSecret) {
      console.error("CRITICAL: SUPABASE_JWT_SECRET is not set in environment variables.");
      return res.status(500).json({ message: "Configuration error: JWT secret not configured." });
    }

    try {
      // Verify the token and cast to our expected payload type
      const decoded = verify(token, jwtSecret) as AuthenticatedUserJwtPayload;

      // Extract necessary information
      const externalUserId = decoded.sub; // For Supabase, 'sub' is the user ID
      const email = decoded.email;
      const applicationId = decoded.app_metadata?.application_id || null;

      if (!externalUserId) {
        // 'sub' claim is essential for identifying the user
        return res
          .status(401)
          .json({ message: "Unauthorized: Invalid token (missing subject/externalUserId)." });
      }

      // Attach the context to the request object
      req.authContext = {
        externalUserId,
        identityProviderName: CURRENT_IDENTITY_PROVIDER_NAME, // Hardcoded for now
        applicationId,
        email,
      };

      return handler(req, res);
    } catch (error: unknown) {
      // Changed from 'any' to 'unknown'
      let errorName: string | undefined;
      let consoleMessage = "Token verification failed.";

      if (error instanceof Error) {
        errorName = error.name;
        consoleMessage = error.message; // Use the actual error message for logging
        console.error("JWT verification failed:", consoleMessage);
      } else {
        // If it's not an Error instance, log the raw error object
        console.error("JWT verification failed with non-Error object:", error);
      }

      if (errorName === "TokenExpiredError") {
        return res.status(401).json({ message: "Unauthorized: Token expired." });
      }
      // JsonWebTokenError covers various issues like malformed token, invalid signature etc.
      if (errorName === "JsonWebTokenError") {
        return res.status(401).json({ message: "Unauthorized: Invalid token." });
      }
      // Fallback for other errors during token verification
      return res.status(401).json({ message: "Unauthorized: Token verification failed." });
    }
  };
};
