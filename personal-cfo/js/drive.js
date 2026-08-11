// Google Drive access.
//
// Auth uses the Google Identity Services token client (browser implicit flow) so
// there is no server and no build step. The app only ever asks for drive.readonly:
// the master workbook is the system of record and is never written back to.

import { DRIVE, ACCOUNTS } from './config.js';
import { store } from './store.js';

const FILES_API = 'https://www.googleapis.com/drive/v3/files';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

export function isSignedIn() {
  return Boolean(accessToken) && Date.now() < tokenExpiry;
}

export function getClientId() {
  return store.get('googleClientId', '') || DRIVE.oauthClientId || '';
}

/**
 * Prompt for a Drive access token. Resolves once the user has granted access.
 * Requires a Google OAuth *Web application* client ID whose authorised JavaScript
 * origin matches wherever this page is served from (e.g. http://localhost:8000).
 */
export function signIn() {
  const clientId = getClientId();
  if (!clientId) {
    return Promise.reject(new Error('No Google OAuth client ID configured. Add one in Settings.'));
  }
  if (!window.google?.accounts?.oauth2) {
    return Promise.reject(new Error('Google Identity Services failed to load. Check your connection.'));
  }

  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE.scope,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        accessToken = resp.access_token;
        // Google returns expires_in seconds; renew a minute early.
        tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
        resolve(accessToken);
      },
    });
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiry = 0;
}

async function driveFetch(url) {
  if (!isSignedIn()) await signIn();
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (resp.status === 401) {
    accessToken = null;
    await signIn();
    return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Drive API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp;
}

/** List every non-trashed child of a folder, following pagination. */
export async function listFolder(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
      pageSize: '200',
      orderBy: 'name',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await driveFetch(`${FILES_API}?${params}`);
    const data = await resp.json();
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

export async function downloadFile(fileId) {
  const resp = await driveFetch(`${FILES_API}/${fileId}?alt=media`);
  return resp.arrayBuffer();
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Score how well a folder/file name identifies an account. */
function matchesAccount(name, account) {
  const n = name.toLowerCase();
  if (account.last4 && n.includes(account.last4)) return 2;
  if (account.match.some((k) => n.includes(k))) return 1;
  return 0;
}

/**
 * Walk the year folders and return every statement PDF, tagged with the account
 * it belongs to. Per-account subfolders are discovered by name so the app keeps
 * working if a folder is renamed or re-created; the IDs in config.js are the
 * fallback.
 */
export async function scanStatements(years = Object.keys(DRIVE.yearFolders)) {
  const statements = [];
  const problems = [];

  for (const year of years) {
    const yearFolderId = DRIVE.yearFolders[year];
    if (!yearFolderId) continue;

    let children;
    try {
      children = await listFolder(yearFolderId);
    } catch (err) {
      problems.push(`Could not read the ${year} folder: ${err.message}`);
      continue;
    }

    const subfolders = children.filter((f) => f.mimeType === FOLDER_MIME);
    // PDFs sitting directly in the year folder (not filed into an account folder).
    const loosePdfs = children.filter((f) => f.mimeType === 'application/pdf');

    for (const account of ACCOUNTS) {
      let folder = subfolders
        .map((f) => ({ f, score: matchesAccount(f.name, account) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.f;

      if (!folder && account.folders[year]) folder = { id: account.folders[year], name: `(configured ${year})` };
      if (!folder) continue;

      let files = [];
      try {
        files = await listFolder(folder.id);
      } catch (err) {
        problems.push(`Could not read ${account.name} ${year}: ${err.message}`);
        continue;
      }
      for (const file of files.filter((f) => f.mimeType === 'application/pdf')) {
        statements.push({
          fileId: file.id,
          fileName: file.name,
          modifiedTime: file.modifiedTime,
          size: Number(file.size || 0),
          year: Number(year),
          accountId: account.id,
          accountName: account.name,
          statementDate: dateFromFileName(file.name),
          folderName: folder.name,
        });
      }
    }

    for (const file of loosePdfs) {
      const best = ACCOUNTS
        .map((a) => ({ a, score: matchesAccount(file.name, a) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0];
      if (!best) {
        problems.push(`${year}: "${file.name}" is not in an account folder and its account could not be identified.`);
        continue;
      }
      statements.push({
        fileId: file.id,
        fileName: file.name,
        modifiedTime: file.modifiedTime,
        size: Number(file.size || 0),
        year: Number(year),
        accountId: best.a.id,
        accountName: best.a.name,
        statementDate: dateFromFileName(file.name),
        folderName: `${year} (loose)`,
      });
    }
  }

  statements.sort((a, b) => (a.statementDate || '').localeCompare(b.statementDate || ''));
  return { statements, problems };
}

/** Statement PDFs are named with a trailing ISO-ish date: "… 2026-07-15.pdf". */
export function dateFromFileName(name) {
  const iso = name.match(/(20\d{2})[-_ ](\d{1,2})[-_ ](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const ym = name.match(/(20\d{2})[-_ ](\d{1,2})\b/);
  if (ym) return `${ym[1]}-${String(ym[2]).padStart(2, '0')}-01`;
  return null;
}

/** Statements not yet recorded in the local ingest registry. */
export function newSince(statements, ingested) {
  const seen = new Set(Object.keys(ingested || {}));
  return statements.filter((s) => !seen.has(s.fileId));
}

export async function fetchMasterWorkbook() {
  return downloadFile(store.get('masterFileId', DRIVE.masterFileId));
}
