import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

// Ensure bcryptjs is installed: yarn add bcryptjs @types/bcryptjs -W (run in root)

const prisma = new PrismaClient();

// Define your authorized applications here.
// The plainTextApiKey will be read from environment variables.
const appsToSeedConfig = [
  {
    applicationId: "realtor_app_v1", // Your main realtor application
    appName: "Realtor Scheduling App",
    envVarForApiKey: "SEED_API_KEY_REALTOR_APP", // Environment variable name for its API key
  },
  {
    applicationId: "another_app_example", // Example for a future application
    appName: "Future Project X",
    envVarForApiKey: "SEED_API_KEY_PROJECT_X",
  },
  // Add more application configurations here as needed
];

async function main() {
  console.log(`Starting seeding of authorized applications...`);

  for (const appConfig of appsToSeedConfig) {
    const plainTextApiKey = process.env[appConfig.envVarForApiKey];

    if (!plainTextApiKey) {
      console.warn(
        `Skipping seeding for ${appConfig.appName} (${appConfig.applicationId}) because its API key environment variable (${appConfig.envVarForApiKey}) is not set.`
      );
      continue;
    }

    // Generate a secure hash of the API key
    // The salt round (12) is a good balance of security and performance.
    const apiKeyHash = await hash(plainTextApiKey, 12);

    try {
      const application = await prisma.authorizedApplication.upsert({
        where: { applicationId: appConfig.applicationId },
        update: {
          appName: appConfig.appName,
          apiKeyHash: apiKeyHash, // Update the hash if the key changes
          isActive: true, // Ensure it's active
        },
        create: {
          applicationId: appConfig.applicationId,
          appName: appConfig.appName,
          apiKeyHash: apiKeyHash,
          isActive: true,
        },
      });
      console.log(
        `Successfully seeded application: ${application.appName} (ID: ${application.applicationId})`
      );
    } catch (error) {
      console.error(`Error seeding application ${appConfig.applicationId}:`, error);
    }
  }

  console.log(`Seeding of authorized applications finished.`);
}

main()
  .catch((e) => {
    console.error("Seeding script failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
