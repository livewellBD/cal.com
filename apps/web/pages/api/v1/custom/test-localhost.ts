import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const targetUrl = "http://localhost:3000/api/auth/session"; // Or any other simple, known-good Cal.com API route
    console.log(`Attempting to fetch from ${targetUrl}`);
    // Adding a timeout to the fetch call can be helpful for debugging network issues
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await response.json();
    console.log("Fetch successful:", data);
    return res.status(response.status).json({ success: true, data });
  } catch (error: unknown) {
    const errorMessage = "Unknown error during localhost fetch";
    let errorDetails: Record<string, unknown> = {};

    if (error instanceof Error) {
      const err = error as NodeJS.ErrnoException & { hostname?: string };

      const errorMessage = err.message;
      const errorDetails = {
        name: err.name,
        message: err.message,
        code: err.code,
        syscall: err.syscall,
        hostname: err.hostname,
        // stack: error.stack, // Potentially too verbose for client response
      };
      console.error("Error during localhost fetch:", error);
    } else {
      console.error("Non-Error object caught during localhost fetch:", error);
      errorDetails = { caughtValue: error };
    }
    return res
      .status(500)
      .json({ success: false, message: `Failed to fetch localhost: ${errorMessage}`, error: errorDetails });
  }
}
