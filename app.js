/**
 * PDF Translator — English to Indonesian
 * Menggunakan PDF.js untuk ekstraksi teks dan Google Translate untuk terjemahan.
 * Berjalan sepenuhnya di browser (client-side).
 */

// =============================================
// Konfigurasi PDF.js worker
// =============================================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// =============================================
// State global
// =============================================
const state = {
  pdfDoc: null,
  totalPages: 0,
  fileName: "",
  pages: [], // [{original, translated}]
  currentPage: 0, // indeks halaman yang sedang ditampilkan (dalam state.pages)
  displayedPages: [], // nomor halaman asli PDF yang diproses
  cancelled: false,
  viewMode: "translated", // 'split' | 'translated' | 'original'
  PAGES_PER_VIEW: 1, // tampilkan 1 halaman per layar
};

// =============================================
// Referensi elemen DOM
// =============================================
const $ = (id) => document.getElementById(id);

const els = {
  pdfInput: $("pdfInput"),
  dropZone: $("dropZone"),
  uploadSection: $("uploadSection"),
  fileInfoBar: $("fileInfoBar"),
  fileName: $("fileName"),
  filePages: $("filePages"),
  btnReset: $("btnReset"),
  btnTranslate: $("btnTranslate"),
  progressSection: $("progressSection"),
  progressLabel: $("progressLabel"),
  progressCount: $("progressCount"),
  progressFill: $("progressFill"),
  progressSub: $("progressSub"),
  btnCancel: $("btnCancel"),
  rangeSection: $("rangeSection"),
  totalPagesInfo: $("totalPagesInfo"),
  rangeFrom: $("rangeFrom"),
  rangeTo: $("rangeTo"),
  btnRangeCancel: $("btnRangeCancel"),
  btnRangeConfirm: $("btnRangeConfirm"),
  resultSection: $("resultSection"),
  resultBadge: $("resultBadge"),
  btnDownloadTxt: $("btnDownloadTxt"),
  btnDownloadDocx: $("btnDownloadDocx"),
  btnNewFile: $("btnNewFile"),
  viewTranslated: $("viewTranslated"),
  viewOriginal: $("viewOriginal"),
  pageNav: $("pageNav"),
  btnPrevPage: $("btnPrevPage"),
  btnNextPage: $("btnNextPage"),
  currentPageDisplay: $("currentPageDisplay"),
  totalPageDisplay: $("totalPageDisplay"),
  resultPages: $("resultPages"),
  jumpInput: $("jumpInput"),
  btnJump: $("btnJump"),
  toast: $("toast"),
  toastMsg: $("toastMsg"),
  toastClose: $("toastClose"),
};

// =============================================
// Utilitas
// =============================================

/** Tampilkan/sembunyikan section */
function showSection(...ids) {
  [
    "uploadSection",
    "fileInfoBar",
    "progressSection",
    "rangeSection",
    "resultSection",
  ].forEach((id) => {
    $(id).classList.add("hidden");
  });
  ids.forEach((id) => $(id) && $(id).classList.remove("hidden"));
}

/** Toast notifikasi */
let toastTimer;
function showToast(msg, duration = 4000) {
  els.toastMsg.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), duration);
}

els.toastClose.addEventListener("click", () =>
  els.toast.classList.add("hidden"),
);

/** Sleep helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pecah teks panjang menjadi beberapa chunk.
 * Google Translate mendukung hingga ~5000 karakter per request,
 * tapi kita batasi 4500 untuk keamanan.
 * Pemecahan dilakukan di batas kalimat agar terjemahan tetap kontekstual.
 */
function chunkText(text, maxLen = 4500) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  // Pecah di batas kalimat (titik, tanda seru, tanda tanya)
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length > maxLen) {
      if (current.trim()) chunks.push(current.trim());
      // Jika satu kalimat saja sudah > maxLen, potong paksa per kata
      if (s.length > maxLen) {
        const words = s.split(" ");
        let sub = "";
        for (const w of words) {
          if (sub.length + w.length + 1 > maxLen) {
            if (sub.trim()) chunks.push(sub.trim());
            sub = w;
          } else {
            sub += (sub ? " " : "") + w;
          }
        }
        if (sub.trim()) current = sub;
        else current = "";
      } else {
        current = s;
      }
    } else {
      current += (current ? " " : "") + s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

// =============================================
// Terjemahan via Google Translate (unofficial)
// =============================================

/**
 * Terjemahkan satu chunk teks menggunakan Google Translate unofficial API.
 * Endpoint ini adalah endpoint yang sama yang digunakan browser Google Translate,
 * tersedia gratis tanpa API key dengan akurasi tinggi.
 * Retry otomatis hingga 3 kali jika terjadi error jaringan.
 */
async function translateChunk(text, retries = 3) {
  if (!text || !text.trim()) return "";

  // Gunakan endpoint Google Translate yang mendukung batch translation
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=en&tl=id&dt=t&q=${encodeURIComponent(text)}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
          // Rate limit — tunggu lalu retry
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      // Respons Google: [[["translated","original",...],...],...]
      // Gabungkan semua segmen terjemahan
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return data[0]
          .map((seg) => (Array.isArray(seg) && seg[0] ? seg[0] : ""))
          .join("");
      }
      return text; // fallback jika format tidak dikenali
    } catch (err) {
      if (attempt === retries - 1) {
        console.warn("Translate error:", err.message);
        return `[Gagal: ${err.message}]`;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  return text;
}

/**
 * Terjemahkan teks panjang dengan memecah ke beberapa chunk,
 * lalu memprosesnya secara PARALEL untuk kecepatan maksimal.
 * Setiap chunk diterjemahkan bersamaan, bukan satu per satu.
 */
async function translateText(text) {
  if (!text || !text.trim()) return "";
  const chunks = chunkText(text, 4500);

  // Proses semua chunk secara paralel (Promise.all)
  const results = await Promise.all(
    chunks.map((chunk) => {
      if (state.cancelled) return Promise.resolve("");
      return translateChunk(chunk);
    }),
  );
  return results.join(" ");
}

// =============================================
// Ekstraksi teks dari PDF
// =============================================

/**
 * Ekstrak teks dari satu halaman PDF.
 */
async function extractPageText(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const textContent = await page.getTextContent();
  return textContent.items
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// =============================================
// Proses utama translate
// =============================================

/**
 * Ekstrak dan terjemahkan satu halaman PDF.
 * Mengembalikan { original, translated }.
 */
async function processPage(pageNum) {
  let originalText = "";
  try {
    originalText = await extractPageText(state.pdfDoc, pageNum);
  } catch (e) {
    originalText = `[Gagal membaca halaman ${pageNum}]`;
  }

  let translatedText = "";
  if (originalText && !originalText.startsWith("[Gagal")) {
    translatedText = await translateText(originalText);
  } else {
    translatedText = originalText;
  }
  return { original: originalText, translated: translatedText };
}

async function runTranslation(fromPage, toPage) {
  state.cancelled = false;
  state.pages = [];
  state.displayedPages = [];
  state.currentPage = 0;

  const total = toPage - fromPage + 1;
  const BATCH_SIZE = 3; // proses 3 halaman sekaligus secara paralel
  let done = 0;

  showSection("progressSection");
  els.progressFill.style.width = "0%";
  els.progressCount.textContent = `0 / ${total}`;
  els.progressSub.textContent = "Memulai terjemahan...";

  // Buat daftar halaman yang akan diproses
  const pageNums = [];
  for (let i = fromPage; i <= toPage; i++) pageNums.push(i);

  // Proses dalam batch (BATCH_SIZE halaman paralel)
  for (let b = 0; b < pageNums.length; b += BATCH_SIZE) {
    if (state.cancelled) break;

    const batch = pageNums.slice(b, b + BATCH_SIZE);
    els.progressSub.textContent = `Menerjemahkan halaman ${batch[0]}${batch.length > 1 ? "–" + batch[batch.length - 1] : ""}...`;

    // Proses batch secara paralel
    const batchResults = await Promise.all(
      batch.map((pageNum) =>
        state.cancelled ? Promise.resolve(null) : processPage(pageNum),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      if (state.cancelled) break;
      const result = batchResults[j];
      if (!result) continue;
      state.pages.push(result);
      state.displayedPages.push(batch[j]);
      done++;
    }

    // Update progress
    const pct = (done / total) * 100;
    els.progressFill.style.width = `${pct}%`;
    els.progressCount.textContent = `${done} / ${total}`;
  }

  if (state.cancelled) {
    if (state.pages.length === 0) {
      showSection("fileInfoBar");
      showToast("Terjemahan dibatalkan.");
      return;
    }
    showToast(
      `Dibatalkan. ${state.pages.length} halaman berhasil diterjemahkan.`,
    );
  }

  // Tampilkan hasil
  els.progressFill.style.width = "100%";
  els.progressCount.textContent = `${state.pages.length} / ${total}`;
  els.progressSub.textContent = "Selesai!";
  await sleep(400);

  renderResults();
}

// =============================================
// Render hasil
// =============================================

function renderResults() {
  state.currentPage = 0;
  els.resultBadge.textContent = `${state.pages.length} halaman`;
  els.totalPageDisplay.textContent = state.pages.length;
  renderCurrentPage();
  showSection("resultSection");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderCurrentPage() {
  const idx = state.currentPage;
  const page = state.pages[idx];
  const pdfPageNum = state.displayedPages[idx];

  els.currentPageDisplay.textContent = idx + 1;
  els.totalPageDisplay.textContent = state.pages.length;
  els.btnPrevPage.disabled = idx === 0;
  els.btnNextPage.disabled = idx === state.pages.length - 1;

  els.resultPages.innerHTML = "";
  const block = createPageBlock(
    page.original,
    page.translated,
    pdfPageNum,
    idx,
  );
  els.resultPages.appendChild(block);
}

function createPageBlock(original, translated, pdfPageNum, idx) {
  const block = document.createElement("div");
  block.className = "page-block";
  block.id = `page-block-${idx}`;

  const viewClass =
    state.viewMode === "split"
      ? ""
      : state.viewMode === "translated"
        ? "view-translated"
        : "view-original";

  block.innerHTML = `
    <div class="page-header">
      <span class="page-number">Halaman ${pdfPageNum}</span>
    </div>
    <div class="page-body ${viewClass}">
      <div class="col col-original">
        <div class="col-header">Teks Asli (Inggris)</div>
        <div class="col-text">${escapeHtml(original) || '<em style="color:#9ca3af">Tidak ada teks terdeteksi</em>'}</div>
      </div>
      <div class="col col-translated">
        <div class="col-header">Terjemahan (Indonesia)</div>
        <div class="col-text">${escapeHtml(translated) || '<em style="color:#9ca3af">Tidak ada teks untuk diterjemahkan</em>'}</div>
      </div>
    </div>
  `;

  return block;
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// =============================================
// View mode
// =============================================

function setViewMode(mode) {
  state.viewMode = mode;
  [els.viewTranslated, els.viewOriginal].forEach((btn) =>
    btn.classList.remove("active"),
  );
  if (mode === "translated") els.viewTranslated.classList.add("active");
  else els.viewOriginal.classList.add("active");
  renderCurrentPage();
}

els.viewTranslated.addEventListener("click", () => setViewMode("translated"));
els.viewOriginal.addEventListener("click", () => setViewMode("original"));

// =============================================
// Navigasi halaman
// =============================================

els.btnPrevPage.addEventListener("click", () => {
  if (state.currentPage > 0) {
    state.currentPage--;
    renderCurrentPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

els.btnNextPage.addEventListener("click", () => {
  if (state.currentPage < state.pages.length - 1) {
    state.currentPage++;
    renderCurrentPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

els.btnJump.addEventListener("click", jumpToPage);
els.jumpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") jumpToPage();
});

function jumpToPage() {
  const val = parseInt(els.jumpInput.value, 10);
  if (isNaN(val) || val < 1 || val > state.pages.length) {
    showToast(`Masukkan nomor halaman antara 1 dan ${state.pages.length}`);
    return;
  }
  state.currentPage = val - 1;
  renderCurrentPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
  els.jumpInput.value = "";
}

// =============================================
// Upload & Drag-Drop
// =============================================

els.pdfInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

els.dropZone.addEventListener("click", () => els.pdfInput.click());

els.dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropZone.classList.add("drag-over");
});

els.dropZone.addEventListener("dragleave", () => {
  els.dropZone.classList.remove("drag-over");
});

els.dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") {
    handleFile(file);
  } else {
    showToast("Hanya file PDF yang didukung.");
  }
});

async function handleFile(file) {
  if (file.type !== "application/pdf") {
    showToast("File harus berformat PDF.");
    return;
  }

  state.fileName = file.name;
  state.pages = [];
  state.displayedPages = [];

  try {
    const arrayBuffer = await file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    state.totalPages = state.pdfDoc.numPages;

    els.fileName.textContent = file.name;
    els.filePages.textContent = `${state.totalPages} halaman terdeteksi`;

    // Sembunyikan upload, tampilkan info bar saja
    showSection("fileInfoBar");
  } catch (err) {
    showToast("Gagal membaca file PDF. Pastikan file tidak terenkripsi/rusak.");
    console.error(err);
  }
}

// =============================================
// Tombol aksi
// =============================================

els.btnTranslate.addEventListener("click", () => {
  if (!state.pdfDoc) return;

  // Jika lebih dari 10 halaman, tampilkan pemilih rentang
  if (state.totalPages > 10) {
    els.totalPagesInfo.textContent = state.totalPages;
    els.rangeFrom.value = 1;
    els.rangeTo.value = Math.min(state.totalPages, 500);
    els.rangeFrom.max = state.totalPages;
    els.rangeTo.max = state.totalPages;
    showSection("fileInfoBar", "rangeSection");
  } else {
    runTranslation(1, state.totalPages);
  }
});

els.btnRangeConfirm.addEventListener("click", () => {
  let from = parseInt(els.rangeFrom.value, 10);
  let to = parseInt(els.rangeTo.value, 10);

  if (isNaN(from) || isNaN(to) || from < 1 || to < from) {
    showToast("Rentang halaman tidak valid.");
    return;
  }
  from = Math.max(1, from);
  to = Math.min(to, state.totalPages, from + 499); // max 500 halaman
  runTranslation(from, to);
});

els.btnRangeCancel.addEventListener("click", () => {
  showSection("fileInfoBar");
});

els.btnCancel.addEventListener("click", () => {
  state.cancelled = true;
  els.progressSub.textContent = "Membatalkan...";
  els.btnCancel.disabled = true;
});

els.btnReset.addEventListener("click", resetApp);
els.btnNewFile.addEventListener("click", resetApp);

function resetApp() {
  state.pdfDoc = null;
  state.totalPages = 0;
  state.fileName = "";
  state.pages = [];
  state.displayedPages = [];
  state.currentPage = 0;
  state.cancelled = false;
  els.pdfInput.value = "";
  els.resultPages.innerHTML = "";
  els.progressFill.style.width = "0%";
  els.btnCancel.disabled = false;
  showSection("uploadSection");
}

// =============================================
// Salin & Unduh
// =============================================

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
}

els.btnDownloadTxt.addEventListener("click", () => {
  if (state.pages.length === 0) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const marginX = 15;
  const marginY = 20;
  const pageW = doc.internal.pageSize.getWidth();
  const maxW = pageW - marginX * 2;
  const lineH = 7;
  let y = marginY;

  const addText = (text, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    const lines = doc.splitTextToSize(text, maxW);
    lines.forEach((line) => {
      if (y + lineH > doc.internal.pageSize.getHeight() - marginY) {
        doc.addPage();
        y = marginY;
      }
      doc.text(line, marginX, y);
      y += lineH;
    });
  };

  state.pages.forEach((p, i) => {
    if (i > 0) {
      doc.addPage();
      y = marginY;
    }

    doc.setFontSize(11);
    addText(`Halaman ${state.displayedPages[i]}`, true);
    y += 3;

    doc.setFontSize(9);
    addText("TEKS ASLI:", true);
    doc.setFontSize(9);
    addText(p.original || "—");
    y += 4;

    doc.setFontSize(9);
    addText("TERJEMAHAN:", true);
    doc.setFontSize(9);
    addText(p.translated || "—");
  });

  doc.save(`terjemahan_${sanitizeName(state.fileName)}.pdf`);
});

els.btnDownloadDocx.addEventListener("click", async () => {
  if (state.pages.length === 0) return;

  showToast("Membuat file .docx, harap tunggu...", 8000);

  try {
    const {
      Document,
      Packer,
      Paragraph,
      TextRun,
      HeadingLevel,
      AlignmentType,
      BorderStyle,
    } = docx;

    const children = [];

    // Judul dokumen
    children.push(
      new Paragraph({
        text: "Hasil Terjemahan PDF",
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "File: ", bold: true }),
          new TextRun({ text: state.fileName }),
          new TextRun({ text: "    |    ", color: "888888" }),
          new TextRun({
            text: `${state.pages.length} halaman diterjemahkan`,
            bold: true,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
      }),
    );

    // Isi per halaman
    for (let i = 0; i < state.pages.length; i++) {
      const p = state.pages[i];
      const pageNum = state.displayedPages[i];

      // Heading halaman
      children.push(
        new Paragraph({
          text: `Halaman ${pageNum}`,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 120 },
        }),
      );

      // Label teks asli
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "TEKS ASLI (INGGRIS)",
              bold: true,
              size: 18,
              color: "2563EB",
            }),
          ],
          spacing: { after: 80 },
        }),
      );

      // Teks asli — pecah per baris
      const originalLines = (p.original || "-").split(/\n/);
      for (const line of originalLines) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: line, color: "555555", size: 20 })],
            spacing: { after: 40 },
            border: {
              left: {
                style: BorderStyle.THICK,
                size: 6,
                color: "CCCCCC",
                space: 8,
              },
            },
            indent: { left: 200 },
          }),
        );
      }

      children.push(new Paragraph({ spacing: { after: 120 } }));

      // Label terjemahan
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "TERJEMAHAN (INDONESIA)",
              bold: true,
              size: 18,
              color: "2563EB",
            }),
          ],
          spacing: { after: 80 },
        }),
      );

      // Teks terjemahan — pecah per baris
      const translatedLines = (p.translated || "-").split(/\n/);
      for (const line of translatedLines) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: line, size: 22 })],
            spacing: { after: 40 },
            border: {
              left: {
                style: BorderStyle.THICK,
                size: 6,
                color: "2563EB",
                space: 8,
              },
            },
            indent: { left: 200 },
          }),
        );
      }

      // Pemisah antar halaman
      if (i < state.pages.length - 1) {
        children.push(
          new Paragraph({
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 1,
                color: "E5E7EB",
                space: 4,
              },
            },
            spacing: { before: 240, after: 240 },
          }),
        );
      }
    }

    const doc = new Document({
      creator: "PDF Translate — Kevin Surya Tjandra",
      title: `Terjemahan — ${state.fileName}`,
      sections: [{ children }],
    });

    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terjemahan_${sanitizeName(state.fileName)}.docx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);

    showToast("File .docx berhasil diunduh.");
  } catch (err) {
    console.error("Gagal membuat docx:", err);
    showToast("Gagal membuat file .docx: " + err.message);
  }
});

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

function sanitizeName(name) {
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .slice(0, 40);
}

// =============================================
// Init
// =============================================

// Prevent double-tap zoom on buttons (Android optimization)
let lastTouchEnd = 0;
document.addEventListener(
  "touchend",
  (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      event.preventDefault();
    }
    lastTouchEnd = now;
  },
  { passive: false },
);

// Add visual feedback for touch events on Android
document.addEventListener("touchstart", (e) => {
  if (
    e.target.classList.contains("btn") ||
    e.target.classList.contains("view-btn") ||
    e.target.classList.contains("page-nav-btn")
  ) {
    e.target.style.opacity = "0.7";
  }
});

document.addEventListener("touchend", (e) => {
  if (
    e.target.classList.contains("btn") ||
    e.target.classList.contains("view-btn") ||
    e.target.classList.contains("page-nav-btn")
  ) {
    e.target.style.opacity = "1";
  }
});

// Optimize scroll performance for Android
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

showSection("uploadSection");
