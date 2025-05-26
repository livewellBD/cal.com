// Example Node.js script (run this once locally or in Codespaces)
// Ensure you have @supabase/supabase-js installed
const { createClient } = require("@supabase/supabase-js");
const supabaseAdmin = createClient(
  "https://rhzsvwulmfxkhiylsvrd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoenN2d3VsbWZ4a2hpeWxzdnJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Nzg3MzYwOSwiZXhwIjoyMDYzNDQ5NjA5fQ.iPq7kBCZDXMbyLE90_yycvCLdROYSr51YxhG8GZCCaw"
);

async function updateUserMetadata() {
  const userIdToUpdate = "d5c631e2-cbe4-4802-a405-0ee9916de2e4"; // The UID of the user you just created
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
    userIdToUpdate,
    { app_metadata: { application_id: "realtor_app_v1" } } // Set your desired application_id
  );
  if (error) console.error("Error updating user metadata:", error);
  else console.log("User metadata updated successfully for user:", userIdToUpdate);
}
updateUserMetadata();
