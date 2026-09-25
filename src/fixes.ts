// Consumer-facing applicable fixes: turn a diagnostic's engine-authored
// `fix.actions[]` into runnable actions, so a consumer renders a generic apply
// button with NO per-code switch. The engine owns the code -> verb mapping and
// the parsed args (see WIRE.md, the `diagnostics` read's `fix`); this layer
// completes the workspace-topology args the engine deliberately does not carry
// (`root`, derived via `resolve_member`) and dispatches by verb.
//
// Node-safe and node-only-anyway: it takes the full `DaemonClient` (the root
// export) because applying a fix runs a mutation.

import type { WireDiagnostic, WireFixAction } from './reads.ts'
import { readResolveMember } from './read-helpers.ts'
import type { DaemonClient, TypedMutate } from './client.ts'

/**
 * The mutation verbs whose engine-supplied `args` are PARTIAL: they author an
 * editable member's `.arsumbris/` file, so the consumer must complete the `root`
 * topology arg (the editable member owning the diagnostic's file), which the
 * engine does not carry. The composition-mutation family, the same set that
 * takes `CompositionMutateOptions.root`. Adding a future root-needing verb is a
 * one-line edit here — NOT a per-diagnostic-code switch.
 */
const COMPOSITION_VERBS_NEEDING_ROOT: ReadonlySet<string> = new Set([
  'add_dep',
  'remove_dep',
  'add_workspace_member',
  'remove_workspace_member',
  'set_workspace_member_role',
  'set_workspace_member_disabled',
])

/** One runnable fix: the engine-authored button caption and the action that runs it. */
export interface AppliableFix {
  /** The button caption, straight from the fix action's engine-authored `title`. */
  title: string
  /**
   * Run the fix. Resolves the mutation's `TypedMutate`; resolves `{ ok: false }`
   * (never throws) when a needed topology arg cannot be resolved (no editable
   * member owns the file, or the engine is not ready). Rejects only on transport
   * failure, as any mutation does.
   */
  apply: () => Promise<TypedMutate>
}

/**
 * Turn a diagnostic into its runnable fixes, one per engine-authored
 * `fix.actions[]`. Returns `[]` when the diagnostic carries no applicable action
 * (an advisory-only fix, or no fix at all). A LIST because a fix may offer a
 * CHOICE of alternatives (the wire `actions` is a list); a consumer renders one
 * button per entry, usually a length-1 list.
 *
 * Branch-free by design: the action names a real `mutate` verb, so this dispatches
 * via `client.mutateByVerb(verb, args)` with no per-code logic. New fixable codes
 * light up for every consumer with zero consumer changes.
 *
 *   const fixes = appliableFix(client, diag)
 *   fixes.forEach((fix) => renderButton(fix.title, fix.apply))
 */
export function appliableFix(client: DaemonClient, diag: WireDiagnostic): AppliableFix[] {
  const actions = diag.fix?.actions
  if (actions === undefined || actions.length === 0) return []
  return actions.map((action) => ({
    title: action.title,
    apply: () => applyAction(client, diag, action),
  }))
}

/**
 * Run one fix action: complete the `root` topology arg for a composition verb,
 * then dispatch by verb. A self-contained verb (`edit_file`) splats its args
 * straight in.
 */
async function applyAction(
  client: DaemonClient,
  diag: WireDiagnostic,
  action: WireFixAction,
): Promise<TypedMutate> {
  const args: Record<string, unknown> = { ...(action.args ?? {}) }

  if (COMPOSITION_VERBS_NEEDING_ROOT.has(action.verb) && args.root === undefined) {
    const resolved = await completeRoot(client, diag.span.file)
    if ('error' in resolved) return { ok: false, error: resolved.error }
    args.root = resolved.root
  }

  return client.mutateByVerb(action.verb, args)
}

/**
 * Derive the editable member `root` for a composition fix: the member owning the
 * diagnostic's file, via `resolve_member`. Returns the reason it could not, so
 * the caller surfaces it as a `{ ok: false }` mutate outcome rather than a wrong
 * mutation.
 */
async function completeRoot(
  client: DaemonClient,
  file: string,
): Promise<{ root: string } | { error: string }> {
  const read = await readResolveMember(client, file)
  if ('ok' in read && read.ok === false) {
    return { error: `appliableFix: resolve_member failed for '${file}': ${read.error}` }
  }
  if (!('ready' in read) || read.ready === false) {
    return { error: `appliableFix: engine not ready to resolve the member owning '${file}'` }
  }
  const member = read.result
  if (member === null) {
    return { error: `appliableFix: no workspace member owns '${file}'` }
  }
  if (!member.editable) {
    return {
      error: `appliableFix: the member '${member.repo}' owning '${file}' is not editable`,
    }
  }
  return { root: member.root }
}
