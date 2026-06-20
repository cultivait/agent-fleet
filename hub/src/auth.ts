import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { removeUserFromAllChannels } from "./channels.js";
import type { User, UserRole } from "./types.js";

const users = new Map<string, User>();
const tokenToName = new Map<string, string>();

export function getUserToken(name: string): string | null {
  return users.get(name)?.token ?? null;
}

export function registerUser(name: string, role: UserRole = "agent", isPrincipal = false): User {
  if (users.has(name)) {
    throw new Error(`User "${name}" is already registered`);
  }
  const token = randomBytes(32).toString("hex");
  const user: User = { name, token, role, registeredAt: Date.now(), isPrincipal };
  users.set(name, user);
  tokenToName.set(token, name);
  return user;
}

export function unregisterUser(name: string): void {
  const user = users.get(name);
  if (user) {
    tokenToName.delete(user.token);
    users.delete(name);
    removeUserFromAllChannels(name);
  }
}

export function authenticateRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return tokenToName.get(token) ?? null;
}

export function getRegisteredUsers(): string[] {
  return Array.from(users.keys());
}

export function getUserRole(name: string): UserRole | null {
  return users.get(name)?.role ?? null;
}

export function getUsersByRole(role: UserRole): string[] {
  return Array.from(users.values())
    .filter((u) => u.role === role)
    .map((u) => u.name);
}

export function isUserRegistered(name: string): boolean {
  return users.has(name);
}

// REFEREE: principal capability — set ONLY via the admin-token /admin-register
// path. routeMessage stamps message.principal:true when the SENDER is a principal
// user, so recipients can treat the message as operator-authenticated. The flag
// lives ONLY in the server-side user record; it is never read from a client body,
// so a join-token user cannot forge it.
export function isPrincipalUser(name: string): boolean {
  return users.get(name)?.isPrincipal === true;
}

// Setter used ONLY by the admin-register path. No-op (returns false) if the user
// is not registered.
export function setPrincipal(name: string, isPrincipal: boolean): boolean {
  const user = users.get(name);
  if (!user) return false;
  user.isPrincipal = isPrincipal;
  return true;
}

export function resetAuthState(): void {
  users.clear();
  tokenToName.clear();
}
