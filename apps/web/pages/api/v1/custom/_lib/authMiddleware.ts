import type { JwtPayload } from "jsonwebtoken";
import { verify } from "jsonwebtoken";
import type { NextApiRequest, NextApiResponse, NextApiHandler } from "next";

// Define a more specific type for your Supabase JWT payload
export interface AuthenticatedUserPayload extends JwtPayload {
  sub: string; // Standard JWT subject claim (user ID for Supabase)
  email?: string; // Email claim from Supabase
  // Add any other claims you expect from your Supabase JWT, e.g., role
  // role?: string;
}

// Extend NextApiRequest to include the decoded user payload
export interface NextApiRequestWithUser extends NextApiRequest {
  user?: AuthenticatedUserPayload; // Use the more specific type
}

export const withAuth = (handler: NextApiHandler) => {
  return async (req: NextApiRequestWithUser, res: NextApiResponse) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized: Missing or malformed token" });
    }

    const token = authHeader.split(" ")[1];
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;

    if (!jwtSecret) {
      console.error("CRITICAL: SUPABASE_JWT_SECRET is not set in environment variables.");
      return res.status(500).json({ message: "Internal Server Error: JWT secret not configured." });
    }

    try {
      // Cast the decoded token to your specific payload type
      const decoded = verify(token, jwtSecret) as AuthenticatedUserPayload;
      req.user = decoded;
      return handler(req, res);
    } catch (error) {
      console.error("JWT verification failed:", error);
      return res.status(401).json({ message: "Unauthorized: Invalid token" });
    }
  };
};
