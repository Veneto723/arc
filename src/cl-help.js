#!/usr/bin/env node
// cl-help: builds the cl command cheat sheet. Two callers:
//   - the `cl:help` sentinel (via cl-switch-hook) — ZERO tokens, the primary way in;
//   - the `/cl` slash command — costs a small model turn, but IS in the native
//     `/` menu, so it's the discoverable bootstrap that points you at cl:help.
// Exported as renderHelp() so both share one source of truth.
'use strict';

const C = require('./cl-config');

function renderHelp() {
  let accounts = [];
  try { accounts = C.loadConfig().accounts.map((a) => a.id); } catch {}
  const example = accounts[1] || accounts[0] || 'pool';

  return `cl — commands
=============
  cl:help   this cheat sheet — ZERO tokens   (or /cl, from the / menu)

Switch account (keeps your conversation, preserves model/effort/mode):
  cl:switch              open the interactive picker — ZERO tokens
  cl:switch ${example.padEnd(12)} switch straight to an account (by name or number)

Add / manage accounts:
  cl:add-account                   open the WIZARD — pick Subscription or Gateway, then guided prompts
  cl:add-account <id>              add a SUBSCRIPTION via guided browser login (in-session);
                                   the login is saved to the account's OWN private profile
                                   (~/.claude/cl-profiles/<id>) — accounts never share a login
  cl:add-account <id> --api --url <gateway> [--label L --color #hex --default]
                                   add a GATEWAY/POOL (like mate): verifies it, auto-detects
                                   models, DPAPI-encrypts the key (from clipboard, or --file/--key)
                                   advanced: --header Key:Value (repeat) · --model opus=<name> (pin,
                                   repeat) · --no-verify (skip /v1/models probe for odd gateways)
  cl:remove-account <id>           remove an account (alias cl:delete-account) — asks, then 'confirm'
  cl set-key <id>                  re-encrypt an api account's key (clipboard/--file/--stdin), DPAPI

Move chats between PCs (discrete export/import — no realtime sync):
  cl:export              archive the CURRENT conversation → ~/cl-export-<ts>.tgz
  cl:export all          archive every session   ·   cl:export <project|id>
  cl:import <archive>    merge sessions in (newer-wins; live chats protected)

See usage:
  cl:peek                usage of ALL accounts + where a launch would land — ZERO tokens

Session:
  cl:restart             reload the wrapper + relaunch this conversation — ZERO tokens
  cl:delete              delete THIS conversation → trash, start fresh (asks; then 'confirm')

Trash (deleted conversations stay recoverable until you empty it):
  cl:trash               list what's in the trash — ZERO tokens
  cl:trash restore <id>  put one back (then resume it: cl --resume <id>)
  cl:restore <id>        same, shorthand
  cl:trash empty         PERMANENTLY purge the trash (asks; then 'confirm')

Why the cl: forms?
  cl:...  are plain messages caught by a hook BEFORE the model runs — they cost
          NO tokens and work even when the account is rate-limited (a slash command
          can't, because its bash needs a safety classifier that runs on the same
          exhausted account). This is why cl:switch / cl:restart / cl:help replaced
          the old /switch and /restart slash commands.
  /cl     the one remaining slash command — same sheet from the / menu (costs a
          small turn); kept only so cl:help is discoverable. Prefer cl:help.

In your terminal (not inside a session):
  cl                     launch
  cl --account <id>      launch on a specific account
  cl add-account <id>    guided browser login to add a subscription (own profile)
  cl capture <id>        adopt the current active login into <id>'s profile
  cl trash [restore <id>|empty]   manage the deleted-conversation trash
  cl doctor              health check    ·    cl setup    reconfigure

Configured accounts: ${accounts.join(', ') || '(none — run `cl setup`)'}
`;
}

module.exports = renderHelp;
// Direct run (the /cl slash command shells out to this): print to stdout.
if (require.main === module) process.stdout.write(renderHelp());
