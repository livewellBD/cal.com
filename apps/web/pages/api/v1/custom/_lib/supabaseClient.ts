import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Supabase URL or Anon Key is not defined. Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env"
  );
  // Depending on your error handling, you might throw an error here in a real app
  // For now, logging an error. API routes using this will fail if not configured.
}

/**
 * Creates a Supabase client instance.
 * If an access token is provided, the client is authenticated for that user.
 * Otherwise, it's an anonymous client (relies on RLS).
 * @param {string} [supabaseAccessToken] - The user's Supabase JWT.
 * @returns {SupabaseClient}
 */
export const getSupabaseClient = (supabaseAccessToken?: string): SupabaseClient => {
  if (!supabaseUrl || !supabaseAnonKey) {
    // This check is important to prevent trying to create a client without config
    throw new Error("Supabase client cannot be initialized without URL and Anon Key.");
  }
  if (supabaseAccessToken) {
    return createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${supabaseAccessToken}` } },
    });
  }
  // Anonymous client - ensure RLS is properly configured in Supabase
  return createClient(supabaseUrl, supabaseAnonKey);
};

// Example for a service role client - use with extreme caution and only when necessary
// export const getSupabaseServiceRoleClient = (): SupabaseClient => {
//   const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
//   if (!supabaseUrl || !serviceRoleKey) {
//     throw new Error("Supabase URL or Service Role Key is not defined for service role client.");
//   }
//   return createClient(supabaseUrl, serviceRoleKey, {
//     auth: {
//       autoRefreshToken: false,
//       persistSession: false,
//     }
//   });
// };
