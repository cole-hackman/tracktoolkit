"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import posthog from "posthog-js";
import { registerSessionExpiredHandler } from "@/lib/api";

interface User {
  id: string;
  username: string;
  avatar_url: string;
  display_name: string;
  soundcloudId?: number;
  canDownload?: boolean;
  /** On the ADMIN_IDS list — unlocks the /admin console link and page. */
  isAdmin?: boolean;
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  login: () => void;
  logout: () => void;
  loading: boolean;
  apiUnreachable: boolean;
  retryAuth: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// API base URL - in production this will be empty (same origin)
// In development, you might need to set NEXT_PUBLIC_API_BASE
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiUnreachable, setApiUnreachable] = useState(false);
  const identifiedUserId = useRef<string | null>(null);

  /** Clear local auth state without redirecting (the api interceptor handles redirects) */
  const clearAuthState = useCallback(() => {
    const persistedUserId = posthog.get_property("$user_id");
    if (identifiedUserId.current || persistedUserId) {
      posthog.reset();
    }
    identifiedUserId.current = null;
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  // Register the session-expired handler so the global 401 interceptor
  // can reset React state when *any* API call returns 401
  useEffect(() => {
    registerSessionExpiredHandler(clearAuthState);
  }, [clearAuthState]);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    setApiUnreachable(false);
    try {
      const response = await fetch(`${API_BASE}/api/auth/me`, {
        credentials: "include",
      });

      if (response.ok) {
        const userData = await response.json();
        const nextUser = {
          id: userData.userId,
          username: userData.username,
          avatar_url: userData.avatarUrl || "",
          display_name: userData.displayName || userData.username,
          soundcloudId: userData.soundcloudId,
          canDownload: !!userData.canDownload,
          isAdmin: !!userData.isAdmin,
        };
        setUser(nextUser);
        setIsAuthenticated(true);

        // The API's userId is the stable account key. Identify once when the
        // OAuth session becomes known so events and captured errors inherit it.
        if (
          typeof nextUser.id === "string" &&
          nextUser.id &&
          identifiedUserId.current !== nextUser.id
        ) {
          const persistedUserId = posthog.get_property("$user_id");
          const currentUserId = identifiedUserId.current || persistedUserId;
          if (currentUserId && currentUserId !== nextUser.id) posthog.reset();
          posthog.identify(nextUser.id, {
            ...(typeof nextUser.username === "string" && nextUser.username
              ? { username: nextUser.username }
              : {}),
            ...(typeof nextUser.display_name === "string" && nextUser.display_name
              ? { name: nextUser.display_name }
              : {}),
          });
          identifiedUserId.current = nextUser.id;
        }
      } else {
        // 401 or any other error — clear local state and any prior analytics identity.
        clearAuthState();

        // If the server told us the session is invalid, clear the cookie
        // so we don't keep sending a stale token
        if (response.status === 401) {
          document.cookie =
            "session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        }
      }
    } catch (error) {
      console.error("Auth check failed:", error);
      setIsAuthenticated(false);
      setUser(null);
      setApiUnreachable(true);
    } finally {
      setLoading(false);
    }
  };

  const login = () => {
    // Redirect to server login endpoint
    window.location.href = `${API_BASE}/api/auth/login`;
  };

  const logout = async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      clearAuthState();
    }
  };

  const retryAuth = () => {
    setLoading(true);
    checkAuthStatus();
  };

  return (
    <AuthContext.Provider
      value={{ isAuthenticated, user, login, logout, loading, apiUnreachable, retryAuth }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
