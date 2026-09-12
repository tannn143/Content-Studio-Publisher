#!/usr/bin/env node
/**
 * CLI cho wallpaper-auto-marketing.
 *
 *   wam serve                       Chay web admin (mac dinh http://127.0.0.1:4000)
 *   wam post --title ... --media ...  Dang bai ngay tu dong lenh
 *   wam verify                      Kiem tra token tat ca kenh
 *   wam channels                    Liet ke kenh da ket noi
 *   wam platforms                   Bang kha nang tung nen tang
 *   wam tick                        Chay scheduler mot lan roi thoat
 */

import process from 'node:process';
import path from 'node:path';

const COMMANDS = ['serve', 'post', 'verify', 'channels', 'platforms', 'tick', 'help'];

/**
 * Parse `--key value`, `--flag`, `--key=value`.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function printHelp() {
  console.log(`
wallpaper-auto-marketing — dang bai tu dong len YouTube, Facebook, Instagram, TikTok, Telegram

  wam serve [--port 4000] [--host 127.0.0.1] [--data ./data] [--token XXX] [--public-url https://...]
      Chay web admin: ket noi kenh bang OAuth, soan bai, hang doi, lich su.

  wam post --title "..." [--desc "..."] [--media a.jpg,b.mp4] [--tags a,b]
           [--channels ch_1,ch_2] [--at "2026-09-20T19:00"] [--dry-run]
      Dang bai ngay (hoac len lich neu co --at) bang cac kenh da ket noi trong ./data.

  wam verify [--channel ch_1]        Kiem tra token con hieu luc.
  wam channels                       Liet ke kenh da ket noi.
  wam platforms                      Bang kha nang cua tung nen tang.
  wam tick                           Chay scheduler mot lan (dung cho cron).

Tuy chon chung: --data <thu-muc-du-lieu> (mac dinh ./data), --log-level info|debug
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const args = parseArgs(argv.slice(cmd === 'help' ? 0 : 1));

  if (cmd === 'help' || args.help) {
    printHelp();
    return;
  }
  if (!COMMANDS.includes(cmd)) {
    console.error(`Khong biet lenh '${cmd}'. Chay \`wam help\` de xem huong dan.`);
    process.exitCode = 1;
    return;
  }

  const dataDir = args.data ?? process.env.WAM_DATA_DIR ?? './data';
  const logLevel = args['log-level'] ?? process.env.WAM_LOG_LEVEL ?? 'info';

  // ------------------------------------------------------------------ serve
  if (cmd === 'serve') {
    const { createAdminServer } = await import('../src/server/server.js');
    const handle = await createAdminServer({
      port: args.port ? Number(args.port) : undefined,
      host: args.host,
      dataDir,
      token: args.token,
      publicUrl: args['public-url'],
      logLevel,
      startScheduler: args['no-scheduler'] ? false : true,
    });
    await handle.start();

    console.log('');
    console.log(`  Web admin: ${handle.url}`);
    if (handle.token) {
      console.log(`  Token dang nhap: ${handle.token}`);
    } else {
      console.log('  Khong dat token (chi truy cap duoc tu localhost).');
      console.log('  Muon mo ra ngoai: dat WAM_ADMIN_TOKEN va --host 0.0.0.0');
    }
    console.log(`  Du lieu: ${path.resolve(dataDir)}`);
    console.log('');

    const shutdown = async (signal) => {
      console.log(`\nDang tat (${signal})...`);
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }

  // Cac lenh con lai dung truc tiep workspace.
  const { Workspace, publicChannel } = await import('../src/core/store/workspace.js');
  const { PublishService } = await import('../src/core/publishservice.js');
  const { createLogger } = await import('../src/core/logger.js');

  const logger = createLogger({ level: logLevel });
  const workspace = await new Workspace({ dir: dataDir }).init();
  const publisher = new PublishService({ workspace, logger });

  try {
    // -------------------------------------------------------------- platforms
    if (cmd === 'platforms') {
      const { capabilitiesTable } = await import('../src/platforms/index.js');
      for (const p of capabilitiesTable()) {
        console.log(
          `${p.platform.padEnd(10)} text=${String(p.text).padEnd(5)} anh=${String(p.image).padEnd(5)} `
          + `video=${String(p.video).padEnd(5)} album=${String(p.album).padEnd(5)} `
          + `caption=${p.limits.caption} hashtag=${p.limits.hashtags}`,
        );
      }
      return;
    }

    // --------------------------------------------------------------- channels
    if (cmd === 'channels') {
      const channels = await workspace.listChannels();
      if (channels.length === 0) {
        console.log('Chua co kenh nao. Chay `wam serve` roi ket noi trong web admin.');
        return;
      }
      for (const ch of channels) {
        const pub = publicChannel(ch);
        console.log(
          `${ch.id}  ${ch.platform.padEnd(10)} ${ch.name}${ch.username ? ` (@${ch.username})` : ''}`
          + `${ch.enabled ? '' : ' [TAT]'}${ch.lastError ? ` [LOI: ${ch.lastError.message}]` : ''}`,
        );
        if (pub.credentials.target) console.log(`    dich: ${pub.credentials.target}`);
      }
      return;
    }

    // ----------------------------------------------------------------- verify
    if (cmd === 'verify') {
      const results = await publisher.verifyChannels(args.channel);
      const entries = Object.entries(results);
      if (entries.length === 0) {
        console.log('Khong co kenh nao de kiem tra.');
        return;
      }
      let bad = 0;
      for (const [id, r] of entries) {
        const name = r.channel?.name ?? id;
        if (r.ok) {
          console.log(`OK   ${name}${r.account?.username ? ` (@${r.account.username})` : ''}`);
        } else {
          bad += 1;
          console.log(`LOI  ${name}: ${r.error}`);
          if (r.hint) console.log(`     -> ${r.hint}`);
        }
      }
      if (bad > 0) process.exitCode = 1;
      return;
    }

    // ------------------------------------------------------------------- tick
    if (cmd === 'tick') {
      const { PostScheduler } = await import('../src/core/scheduler.js');
      const scheduler = new PostScheduler({ workspace, publisher, logger });
      const res = await scheduler.tick();
      console.log(`Da dang: ${res.published}, that bai: ${res.failed}`);
      if (res.failed > 0) process.exitCode = 1;
      return;
    }

    // ------------------------------------------------------------------- post
    if (cmd === 'post') {
      const title = args.title ?? '';
      const description = args.desc ?? args.description ?? '';
      const mediaPaths = splitList(args.media);
      const tags = splitList(args.tags ?? args.hashtags);

      if (!title && !description && mediaPaths.length === 0) {
        console.error('Can it nhat --title, --desc hoac --media');
        process.exitCode = 1;
        return;
      }

      // Upload media vao workspace de dung chung co che voi web admin.
      const { toMedia } = await import('../src/core/media.js');
      const { copyFile } = await import('node:fs/promises');
      const { newId } = await import('../src/core/store/jsonstore.js');
      /** @type {string[]} */
      const mediaIds = [];
      for (const p of mediaPaths) {
        const media = toMedia(p);
        await media.load();
        await media.probeWithFfprobe().catch(() => null);
        const id = newId('m');
        const stored = path.join(workspace.uploadsDir, `${id}${media.extension || ''}`);
        await copyFile(/** @type {string} */ (media.filePath), stored);
        const rec = await workspace.addMedia({
          filename: media.filename ?? path.basename(p),
          mime: /** @type {string} */ (media.mime),
          kind: /** @type {string} */ (media.kind),
          size: media.size ?? 0,
          storedPath: stored,
          width: media.width,
          height: media.height,
          durationSec: media.durationSec,
        });
        mediaIds.push(rec.id);
      }

      const all = await workspace.listChannels();
      const wanted = splitList(args.channels);
      const channels = wanted.length > 0
        ? all.filter((c) => wanted.includes(c.id) || wanted.includes(c.platform) || wanted.includes(c.name))
        : all.filter((c) => c.enabled);
      if (channels.length === 0) {
        console.error('Khong tim thay kenh nao. Chay `wam channels` de xem danh sach.');
        process.exitCode = 1;
        return;
      }

      const scheduledAt = args.at ? new Date(args.at).toISOString() : null;
      const post = await workspace.createPost({
        content: { title, description, hashtags: tags, link: args.link },
        mediaIds,
        channelIds: channels.map((c) => c.id),
        scheduledAt,
        status: scheduledAt ? 'queued' : 'draft',
      });

      if (scheduledAt) {
        console.log(`Da len lich ${new Date(scheduledAt).toLocaleString('vi-VN')} cho ${channels.length} kenh (post ${post.id}).`);
        console.log('Chay `wam serve` hoac `wam tick` de scheduler dang bai.');
        return;
      }

      const { report } = await publisher.publishPost(post.id, { dryRun: Boolean(args['dry-run']) });
      console.log('');
      for (const r of report.results) {
        const ch = channels.find((c) => c.id === r.channel);
        const name = ch?.name ?? r.channel;
        if (r.skipped) console.log(`BO QUA ${name}: ${r.reason}`);
        else if (r.ok) console.log(`OK     ${name}${r.url ? ` -> ${r.url}` : ''}${r.status ? ` (${r.status})` : ''}`);
        else {
          console.log(`LOI    ${name}: ${r.error?.message}`);
          if (r.error?.hint) console.log(`       -> ${r.error.hint}`);
        }
      }
      console.log('');
      console.log(`Thanh cong ${report.succeeded.length}/${report.results.length}`);
      if (report.failed.length > 0) process.exitCode = 1;
      return;
    }
  } finally {
    await publisher.close();
  }
}

/** @param {any} v */
function splitList(v) {
  if (!v || v === true) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

main().catch((err) => {
  console.error(`\nLoi: ${err?.message ?? err}`);
  if (err?.hint) console.error(`-> ${err.hint}`);
  if (process.env.WAM_LOG_LEVEL === 'debug') console.error(err?.stack);
  process.exitCode = 1;
});
