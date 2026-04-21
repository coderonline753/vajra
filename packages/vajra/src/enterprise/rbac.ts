/**
 * Vajra RBAC — Role-Based Access Control
 * Declarative permissions with role hierarchy support.
 */

import type { Context } from '../context';
import type { Middleware } from '../middleware';

interface RbacOptions {
  roleExtractor?: (c: Context) => string | string[] | Promise<string | string[]>;
  roleKey?: string;
  errorMessage?: string;
  onDenied?: (c: Context) => Response | Promise<Response>;
}

interface RoleDefinition {
  permissions: string[];
  inherits?: string[];
}

export class AccessControl {
  private roles = new Map<string, RoleDefinition>();
  private resolvedPermissions = new Map<string, Set<string>>();

  /** Define a role with permissions and optional inheritance */
  define(role: string, permissions: string[], inherits?: string[]): this {
    this.roles.set(role, { permissions, inherits });
    this.resolvedPermissions.clear(); // invalidate cache
    return this;
  }

  /** Resolve all permissions for a role (including inherited) */
  private resolve(role: string, visited = new Set<string>()): Set<string> {
    // Check cache
    const cached = this.resolvedPermissions.get(role);
    if (cached) return cached;

    // Prevent circular inheritance
    if (visited.has(role)) return new Set();
    visited.add(role);

    const definition = this.roles.get(role);
    if (!definition) return new Set();

    const perms = new Set(definition.permissions);

    // Resolve inherited permissions
    if (definition.inherits) {
      for (const parent of definition.inherits) {
        const parentPerms = this.resolve(parent, visited);
        for (const p of parentPerms) perms.add(p);
      }
    }

    // Cache
    this.resolvedPermissions.set(role, perms);
    return perms;
  }

  /** Check if a role has a specific permission */
  can(role: string | string[], permission: string): boolean {
    const roles = Array.isArray(role) ? role : [role];
    for (const r of roles) {
      const perms = this.resolve(r);
      if (perms.has(permission) || perms.has('*')) return true;
    }
    return false;
  }

  /** Middleware: require specific permission(s) */
  require(...permissions: string[]): (options?: RbacOptions) => Middleware {
    return (options: RbacOptions = {}) => {
      const roleKey = options.roleKey ?? 'role';
      const errorMessage = options.errorMessage ?? 'Forbidden: insufficient permissions';

      return async (c, next) => {
        // Extract roles
        let roles: string[];
        if (options.roleExtractor) {
          const result = await options.roleExtractor(c);
          roles = Array.isArray(result) ? result : [result];
        } else {
          // Try context store first, then JWT payload
          const directRole = c.get<string | string[]>(roleKey);
          if (directRole) {
            roles = Array.isArray(directRole) ? directRole : [directRole];
          } else {
            const jwtPayload = c.get<Record<string, unknown>>('jwtPayload');
            if (jwtPayload && jwtPayload[roleKey]) {
              const r = jwtPayload[roleKey];
              roles = Array.isArray(r) ? r as string[] : [String(r)];
            } else {
              if (options.onDenied) return options.onDenied(c);
              return c.json({ error: errorMessage }, 403);
            }
          }
        }

        // Check all required permissions
        for (const perm of permissions) {
          if (!this.can(roles, perm)) {
            if (options.onDenied) return options.onDenied(c);
            return c.json({ error: errorMessage }, 403);
          }
        }

        return next();
      };
    };
  }

  /** Middleware: require one of the listed roles */
  requireRole(...allowedRoles: string[]): (options?: RbacOptions) => Middleware {
    const allowedSet = new Set(allowedRoles);

    return (options: RbacOptions = {}) => {
      const roleKey = options.roleKey ?? 'role';
      const errorMessage = options.errorMessage ?? 'Forbidden: insufficient role';

      return async (c, next) => {
        let roles: string[];
        if (options.roleExtractor) {
          const result = await options.roleExtractor(c);
          roles = Array.isArray(result) ? result : [result];
        } else {
          const directRole = c.get<string | string[]>(roleKey);
          if (directRole) {
            roles = Array.isArray(directRole) ? directRole : [directRole];
          } else {
            const jwtPayload = c.get<Record<string, unknown>>('jwtPayload');
            if (jwtPayload && jwtPayload[roleKey]) {
              const r = jwtPayload[roleKey];
              roles = Array.isArray(r) ? r as string[] : [String(r)];
            } else {
              if (options.onDenied) return options.onDenied(c);
              return c.json({ error: errorMessage }, 403);
            }
          }
        }

        const hasRole = roles.some(r => allowedSet.has(r));
        if (!hasRole) {
          if (options.onDenied) return options.onDenied(c);
          return c.json({ error: errorMessage }, 403);
        }

        return next();
      };
    };
  }
}
