function fmtMiB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function hashColor(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

function sliceAndDice(items, x, y, w, h) {
  // Deterministic slice-and-dice treemap (simple MVP).
  const total = items.reduce((sum, it) => sum + it.value, 0) || 1;
  const out = [];
  let offset = 0;
  const horizontal = w >= h;
  for (const it of items) {
    const frac = it.value / total;
    if (horizontal) {
      const iw = Math.max(1, Math.floor(w * frac));
      out.push({ ...it, x: x + offset, y, w: iw, h });
      offset += iw;
    } else {
      const ih = Math.max(1, Math.floor(h * frac));
      out.push({ ...it, x, y: y + offset, w, h: ih });
      offset += ih;
    }
  }
  return out;
}

async function main() {
  const res = await fetch("/analysis.json");
  const analysis = await res.json();

  const overview = document.getElementById("overview");
  const nm = analysis.nodeModules;
  const pills = [
    ["Packages", String(analysis.packages?.length ?? 0)],
    ["Duplicates", String(analysis.duplicates?.length ?? 0)],
    ["Max depth", String(analysis.depth?.maxDepth ?? 0)],
    ["node_modules logical", nm?.logicalBytes != null ? `${fmtMiB(nm.logicalBytes)} MiB` : "n/a"],
    ["node_modules physical", nm?.physicalBytes != null ? `${fmtMiB(nm.physicalBytes)} MiB` : "n/a"]
  ];
  for (const [k, v] of pills) {
    const div = document.createElement("div");
    div.className = "pill";
    div.textContent = `${k}: ${v}`;
    overview.appendChild(div);
  }

  const rows = (analysis.packages ?? [])
    .filter((p) => p.sizes?.physicalBytes != null)
    .sort((a, b) => (b.sizes.physicalBytes ?? 0) - (a.sizes.physicalBytes ?? 0));

  // Treemap for top 80
  const top = rows.slice(0, 80).map((p) => ({
    key: p.key,
    value: Math.max(1, p.sizes.physicalBytes || 1)
  }));

  const canvas = document.getElementById("treemap");
  const ctx = canvas.getContext("2d");
  const rects = sliceAndDice(top, 0, 0, canvas.width, canvas.height);

  const tooltip = document.createElement("div");
  tooltip.style.position = "fixed";
  tooltip.style.pointerEvents = "none";
  tooltip.style.background = "rgba(17,24,39,0.95)";
  tooltip.style.border = "1px solid rgba(255,255,255,0.12)";
  tooltip.style.color = "rgba(229,231,235,0.95)";
  tooltip.style.padding = "6px 8px";
  tooltip.style.borderRadius = "10px";
  tooltip.style.fontSize = "12px";
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const r of rects) {
      ctx.fillStyle = hashColor(r.key);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      if (r.w > 120 && r.h > 20) {
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.font = "12px ui-monospace, Menlo, Monaco, Consolas, monospace";
        ctx.fillText(r.key, r.x + 6, r.y + 14);
      }
    }
  }
  draw();

  function hitTest(px, py) {
    for (const r of rects) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
    }
    return null;
  }

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const r = hitTest(px, py);
    if (!r) {
      tooltip.style.display = "none";
      return;
    }
    tooltip.style.display = "block";
    tooltip.textContent = `${r.key}: ${fmtMiB(r.value)} MiB`;
    tooltip.style.left = `${e.clientX + 10}px`;
    tooltip.style.top = `${e.clientY + 10}px`;
  });
  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });

  // Table
  const tbody = document.getElementById("table");
  const filter = document.getElementById("filter");
  function renderTable(query) {
    const q = (query || "").toLowerCase();
    tbody.textContent = "";
    for (const p of rows.slice(0, 500)) {
      if (q && !p.key.toLowerCase().includes(q)) continue;
      const tr = document.createElement("tr");
      const tdKey = document.createElement("td");
      tdKey.textContent = p.key;
      tdKey.className = "mono";
      const tdPhys = document.createElement("td");
      tdPhys.textContent = fmtMiB(p.sizes.physicalBytes || 0);
      const tdLog = document.createElement("td");
      tdLog.textContent = fmtMiB(p.sizes.logicalBytes || 0);
      const tdPaths = document.createElement("td");
      tdPaths.textContent = (p.paths || []).slice(0, 3).join("\n") + ((p.paths || []).length > 3 ? "\n…" : "");
      tdPaths.className = "mono";
      tr.appendChild(tdKey);
      tr.appendChild(tdPhys);
      tr.appendChild(tdLog);
      tr.appendChild(tdPaths);
      tbody.appendChild(tr);
    }
  }
  renderTable("");
  filter.addEventListener("input", () => renderTable(filter.value));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
});

