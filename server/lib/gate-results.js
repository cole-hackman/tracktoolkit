/**
 * What the Downloads page reports about gate downloads (Hypeddit, Droploud,
 * Cobrand). The extension works the gates in the browser and never talks to
 * this server, but it already tells the page, per track, how each one ended;
 * the page forwards that here so the admin console can count them next to the
 * direct downloads the server sees for itself.
 *
 * One OperationLog row per track outcome (`action: 'gate-download'`), with the
 * track id in `metadata.trackIds` like every other download row, so the
 * catalog's per-track touch counts pick it up with no extra work.
 */
export const GATE_SITES = ['hypeddit', 'droploud', 'cobrand'];
export const GATE_OUTCOMES = ['done', 'failed'];
/** The account actions the extension records per gate (service-worker SUMMARY_ACTIONS). */
export const GATE_ACTIONS = ['follow', 'like', 'comment', 'repost', 'email-signup', 'sms-signup'];
export const GATE_RESULTS_MAX = 50;
export const GATE_ACTION_NAME = 'gate-download';

/** Same key on client and server, so a repeated report is recognised. */
export const gateResultKey = (id, status) => `${id}:${status}`;
