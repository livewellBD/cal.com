"use client";

// --- FOR IFRAME/MODULARIZATION/MICRO-SERVICE: ADDED useEffect,useSearchParams ---
//import useTheme from "@calcom/lib/hooks/useTheme";
import { useTheme } from "next-themes";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

import getBrandColours from "@calcom/lib/getBrandColours";
import useMeQuery from "@calcom/trpc/react/hooks/useMeQuery";
import { useCalcomTheme } from "@calcom/ui/styles";

export const useAppTheme = () => {
  const { data: user } = useMeQuery();
  const brandTheme = getBrandColours({
    lightVal: user?.brandColor,
    darkVal: user?.darkBrandColor,
  });
  useCalcomTheme(brandTheme);
  //useTheme(user?.appTheme); // Commented out original logic

  // --- FOR IFRAME/MODULARIZATION/MICRO-SERVICE > START: MODIFIED THEME LOGIC ---

  // 1. Read the theme from the URL query parameters.
  const searchParams = useSearchParams();
  const themeFromQuery = searchParams.get("theme");

  // 2. Get the `setTheme` function from our theme hook.
  const { setTheme } = useTheme();

  // 3. Use an effect to set the theme based on the query param or user's preference.
  useEffect(() => {
    // If a valid theme ('light' or 'dark') is in the URL, prioritize it.
    if (themeFromQuery === "light" || themeFromQuery === "dark") {
      setTheme(themeFromQuery);
    } else if (user) {
      // Otherwise, fall back to the user's saved preference.
      // If the user has no preference, default to 'light'.
      setTheme(user.appTheme || "light");
    }
    // Rerun this effect if the query param changes or when user data loads.
  }, [themeFromQuery, user, setTheme]);

  // --- END: MODIFIED THEME LOGIC ---
};
