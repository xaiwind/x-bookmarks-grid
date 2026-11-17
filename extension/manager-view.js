import { displayTitle } from "../src/core.js";
import { columnCountForWidth, formatCompactCount, getBookmarkPostType, isRecognizedArticle } from "../src/manager-core.js";
import { t, tr } from "../src/i18n.js";

const MIN_COVER_RATIO = 0.62;
const MAX_COVER_RATIO = 2.4;
const DEFAULT_COVER_RATIO = 1.5;
const CARD_TEXT_HEIGHT = 118;
const TEXT_CARD_MIN_HEIGHT = 205;
const TITLE_LINE_HEIGHT = 25;
const TITLE_MAX_LINES = 4;
const TONE_COUNT = 5;

export function coverRatio(record) {
  const ratio = Number(record.coverRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_COVER_RATIO;
  return Math.min(MAX_COVER_RATIO, Math.max(MIN_COVER_RATIO, ratio));
}

/** Rough card height used to keep masonry columns balanced without measuring the DOM. */
export function estimateCardHeight(record, columnWidth) {
  const title = String(record.title || "");
  const charsPerLine = Math.max(8, Math.floor((columnWidth - 36) / 15));
  const titleHeight = Math.min(TITLE_MAX_LINES, Math.max(1, Math.ceil(title.length / charsPerLine))) * TITLE_LINE_HEIGHT;
  if (!(record.imageUrls || []).length) return Math.max(TEXT_CARD_MIN_HEIGHT, CARD_TEXT_HEIGHT + titleHeight);
  return columnWidth / coverRatio(record) + CARD_TEXT_HEIGHT - TITLE_LINE_HEIGHT + titleHeight;
}

export function imageVariant(value, size) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com") return "";
    if (/\/(media|card_img)\//.test(url.pathname)) url.searchParams.set("name", size);
    return url.href;
  } catch {
    return "";
  }
}

function kickerLabel(record) {
  const type = getBookmarkPostType(record);
  if (isRecognizedArticle(record)) return record.classificationVerified ? tr`X 文章 · ${Number(record.textLength).toLocaleString()} 字` : t("X 文章");
  if (type === "long") return t("长文");
  if (record.hasVideo) return t("视频");
  if (type === "short") return t("短推");
  return t("收藏");
}

export function cardTemplate(record) {
  const images = (record.imageUrls || []).map((url) => imageVariant(url, "small")).filter(Boolean);
  const title = displayTitle(record);
  const note = String(record.note || "").trim();
  const tone = [...String(record.id || title)].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) >>> 0, 0) % TONE_COUNT;
  const url = safePostUrl(record.url);
  const views = formatCompactCount(record.views);
  const author = String(record.author || "unknown");
  const gallery = images.length
    ? `<div class="card-gallery single"><a class="card-image-link" style="--cover-ratio:${coverRatio(record)}" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${escapeHtml(title)}"><img class="card-image" src="${escapeHtml(images[0])}" data-fallbacks="${escapeHtml(JSON.stringify(images.slice(1)))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">${record.hasVideo ? `<span class="video-indicator">▶ ${t("视频")}</span>` : ""}</a></div>`
    : "";
  return `<article class="bookmark-card tone-${tone}${images.length ? "" : " text-card"}" data-id="${escapeHtml(record.id)}">
    ${gallery}
    <div class="card-content"><div class="card-kicker"><span>${escapeHtml(kickerLabel(record))}</span>${views ? `<span class="card-views">${escapeHtml(tr`${views} 次浏览`)}</span>` : ""}</div>
    <h3 class="card-title"><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></h3>${note ? `<p class="card-note">${escapeHtml(note)}</p>` : ""}
    <div class="card-footer"><span class="card-author"><button type="button" class="author-link" data-author="${escapeHtml(author)}" title="${escapeHtml(tr`只看 @${author} 的收藏`)}">@${escapeHtml(author)}</button><span class="card-date"> · ${escapeHtml(formatDate(record.createdAt || record.syncedAt))}</span></span><span class="card-buttons"><button type="button" class="card-more" aria-haspopup="menu" aria-label="${escapeHtml(tr`更多操作：${title}`)}" title="${t("更多操作（也可以右键卡片）")}">⋯</button><a class="card-open" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(tr`打开原帖：${title}`)}">↗</a></span></div></div>
  </article>`;
}

/** Swaps in the next candidate cover when one fails, or turns the card into a text card. */
export function handleImageError(event) {
  const image = event.target;
  if (!image?.matches?.(".card-image")) return;
  let remaining = [];
  try { remaining = JSON.parse(image.dataset.fallbacks || "[]"); } catch { remaining = []; }
  const [next, ...rest] = Array.isArray(remaining) ? remaining : [];
  if (next) {
    image.dataset.fallbacks = JSON.stringify(rest);
    image.src = next;
    return;
  }
  image.closest(".bookmark-card")?.classList.add("text-card");
  image.closest(".card-gallery")?.remove();
}

/**
 * A masonry that renders cards in batches as the user scrolls, so large libraries open instantly.
 * @param {HTMLElement} container
 * @param {{ batchSize?: number, gap?: number }} [options]
 */
export function createMasonry(container, { batchSize = 48, gap = 18 } = {}) {
  let items = [];
  let rendered = 0;
  let columns = [];
  let heights = [];
  let renderedKeys = [];
  const sentinel = document.createElement("div");
  sentinel.className = "masonry-sentinel";
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) appendUntil(rendered + batchSize);
  }, { rootMargin: "1600px 0px" });
  // Rebuilding changes the container's own size, so do it on the next frame: resizing the
  // observed element inside the callback makes the browser report a ResizeObserver loop.
  let resizeFrame = 0;
  new ResizeObserver(() => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (items.length && columnCountForWidth(container.clientWidth, { gap }) !== columns.length) rebuild(rendered);
    });
  }).observe(container);

  function rebuild(target) {
    observer.unobserve(sentinel);
    const count = columnCountForWidth(container.clientWidth, { gap });
    const grid = document.createElement("div");
    grid.className = "masonry-grid";
    columns = Array.from({ length: count }, () => {
      const column = document.createElement("div");
      column.className = "masonry-column";
      return column;
    });
    heights = columns.map(() => 0);
    grid.append(...columns);
    container.replaceChildren(grid, sentinel);
    rendered = 0;
    renderedKeys = [];
    appendUntil(Math.max(target, batchSize));
  }

  function appendUntil(target) {
    const end = Math.min(items.length, target);
    const columnWidth = Math.max(160, (container.clientWidth - gap * (columns.length - 1)) / columns.length);
    const template = document.createElement("template");
    for (; rendered < end; rendered += 1) {
      template.innerHTML = cardTemplate(items[rendered]);
      const index = heights.indexOf(Math.min(...heights));
      columns[index].append(template.content);
      heights[index] += estimateCardHeight(items[rendered], columnWidth) + gap;
      renderedKeys.push(cardKey(items[rendered]));
    }
    // Re-observing forces a fresh check, so short batches keep filling the viewport.
    observer.unobserve(sentinel);
    if (rendered < items.length) observer.observe(sentinel);
  }

  return {
    /** @param {object[]} nextItems @param {{ keepRendered?: boolean }} [options] */
    setItems(nextItems, { keepRendered = false } = {}) {
      // When a sync only adds cards below what is already on screen, leave the page untouched.
      const unchangedOnScreen = keepRendered && columns.length > 0 && nextItems.length >= rendered
        && renderedKeys.every((key, index) => key === cardKey(nextItems[index]));
      items = nextItems;
      if (unchangedOnScreen) appendUntil(Math.max(rendered, batchSize));
      else rebuild(keepRendered ? rendered : 0);
    },
    showMessage(html) {
      observer.unobserve(sentinel);
      items = [];
      rendered = 0;
      columns = [];
      renderedKeys = [];
      container.innerHTML = html;
    },
  };
}

/** Identifies what a card shows; a changed key means the card must be redrawn. */
export function cardKey(record) {
  return `${record.id}|${record.title}|${(record.imageUrls || [])[0] || ""}|${record.views || ""}|${record.textLength || ""}|${record.classificationVerified ? 1 : 0}|${record.note || ""}|${record.untitled ? 1 : 0}`;
}

function safePostUrl(value) {
  return /^https:\/\/(x|twitter)\.com\//.test(String(value || "")) ? String(value) : "#";
}

function formatDate(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime()) ? t("时间未知") : date.toLocaleDateString();
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
