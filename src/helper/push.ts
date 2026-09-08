/**
 * A push, as the six steps of MANUAL §7 (ticket 09's decisions table).
 *
 * 1. A forced push is refused. 2. A pre-flight fetch: if the source moved
 * since the served commit, the push is refused as if someone had pushed
 * first. 3. The served commit must be an ancestor of the pushed one. 4 and 5.
 * The net diff is sorted into per-root changes (`changes.ts`) and each
 * root's adapter applies its share. 6. A post-push fetch on top of the pushed
 * commit picks up the ids and the source's normalisation, and the private
 * ref moves there.
 *
 * The private ref only ever advances to a commit the adapters have seen:
 * after the pre-flight fetch (a real fetch) and after the post-push fetch.
 * A refusal or an adapter error leaves it where it was.
 */
import type { Manifest } from '../manifest/types.js';
import type { PushedDocument } from '../source.js';
import { planChanges } from './changes.js';
import { type FetchDeps, fetchCommit } from './fetch.js';
import { INDEX_PATH, parseIndex } from './index-file.js';
import { readTree } from './tree.js';

export interface PushRequest {
  manifest: Manifest;
  /** As git sent it: `[+]<src>:<dst>`. */
  refspec: string;
  /** The private ref, `refs/docsync/<remote>/main`. */
  ref: string;
  /** The branch this remote serves. */
  branch: string;
}

export type PushOutcome = { ok: true } | { ok: false; message: string };

/** Runs one push. Adapter errors propagate; the caller turns them into `error`. */
export async function pushRef(deps: FetchDeps, request: PushRequest): Promise<PushOutcome> {
  const { git } = deps;
  const refuse = (message: string): PushOutcome => ({ ok: false, message });

  // 1. The refspec.
  const forced = request.refspec.startsWith('+');
  const [source = '', destination = ''] = request.refspec.replace(/^\+/, '').split(':');
  if (destination !== request.branch) {
    return refuse(`only ${request.branch} can be pushed to a docsync remote`);
  }
  if (forced) return refuse('force push is not supported; fetch, merge and push again');

  // 2. The pre-flight fetch.
  const served = await git.revParse(request.ref);
  const preflight = await fetchCommit(deps, request.manifest, served);
  if (preflight.changed) {
    await git.updateRef(request.ref, preflight.commit);
    return refuse('the source changed since the last fetch; fetch and merge first');
  }

  // 3. Fast-forward only.
  const pushed = await git.revParse(source);
  if (pushed === undefined) return refuse(`${source} is not a commit`);
  if (!(await git.isAncestor(preflight.commit, pushed))) {
    return refuse('non-fast-forward; fetch and merge first');
  }

  // 4 and 5. The diff, sorted and applied.
  const previous = await readTree(git, preflight.commit);
  const indexBlob = previous.get(INDEX_PATH);
  const index = parseIndex(
    indexBlob === undefined ? '' : (await git.catBlob(indexBlob.sha)).toString('utf8'),
  );
  const diff = await git.diffTree(preflight.commit, pushed);
  const plan = await planChanges(
    diff,
    request.manifest.roots,
    index,
    (path) => git.catBlob(`${pushed}:${path}`),
    // The served tree is the base every diff-based write-back is computed
    // from (MANUAL §7); it is already read above, so this costs one blob.
    async (path) => {
      const file = previous.get(path);
      return file === undefined ? undefined : git.catBlob(file.sha);
    },
  );
  // A push stops at the first refused path, as it always has; `docsync status`
  // is what lists them all, without a push (ticket 31).
  const refused = plan.refusals[0];
  if (refused !== undefined) throw new Error(refused.message);
  const documents: PushedDocument[] = [];
  for (const { root, changes } of plan.roots) {
    const report = await deps.sources[root.src.source].pushRoot(
      root,
      changes,
      deps.provider,
      index,
      { progress: deps.log },
    );
    for (const done of report) deps.log(`${root.src.source}: ${done.action} ${done.path}`);
    documents.push(...report);
  }

  // 6. The post-push fetch, on top of what was pushed. Under a suggest root it
  // is what takes the body back to the source text: the push wrote suggestions,
  // and the documents themselves did not change (MANUAL §7).
  const suggested = documents.filter((one) => one.action === 'suggested').map((one) => one.title);
  const after = await fetchCommit(deps, request.manifest, pushed, { suggested });
  await git.updateRef(request.ref, after.commit);
  // The report file is the CLI's only channel: by the time `docsync push`
  // prints, git has interleaved the progress lines above with its own output
  // (ticket 10).
  await deps.report?.push({ at: after.report.at, documents, skipped: after.report.skipped });
  return { ok: true };
}
