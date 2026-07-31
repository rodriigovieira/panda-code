/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as devices from "../devices.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_commandPayloads from "../lib/commandPayloads.js";
import type * as lib_retention from "../lib/retention.js";
import type * as lib_stranded from "../lib/stranded.js";
import type * as maintenance from "../maintenance.js";
import type * as notifications from "../notifications.js";
import type * as pairing from "../pairing.js";
import type * as sessions from "../sessions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  commands: typeof commands;
  crons: typeof crons;
  devices: typeof devices;
  "lib/auth": typeof lib_auth;
  "lib/commandPayloads": typeof lib_commandPayloads;
  "lib/retention": typeof lib_retention;
  "lib/stranded": typeof lib_stranded;
  maintenance: typeof maintenance;
  notifications: typeof notifications;
  pairing: typeof pairing;
  sessions: typeof sessions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
