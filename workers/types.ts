// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	// POLICY_AUD and TEAM_DOMAIN are production-only (not in wrangler.jsonc vars),
	// so they must be declared here. FORWARD_TO lives in wrangler.jsonc vars and is
	// generated into Cloudflare.Env by `wrangler types`, alongside DOMAINS/EMAIL_ADDRESSES.
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
}
