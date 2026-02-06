function runTypingLoop() {
  const target = document.querySelector(".line-1");
  if (!target) return;

  const full = '> better install<span class="cursor">█</span>';
  const plain = "> better install";
  let index = 0;
  let deleting = false;

  const tick = () => {
    if (!deleting) {
      index += 1;
      if (index >= plain.length) {
        target.innerHTML = full;
        setTimeout(() => {
          deleting = true;
          tick();
        }, 1800);
        return;
      }
    } else {
      index -= 1;
      if (index <= 0) {
        deleting = false;
        index = 0;
      }
    }

    const slice = plain.slice(0, index);
    target.innerHTML = `<span class="prompt">&gt;</span>${slice.startsWith(">") ? slice.slice(1) : slice}<span class="cursor">█</span>`;
    setTimeout(tick, deleting ? 35 : 70);
  };

  setTimeout(tick, 2600);
}

function activateMenuHighlights() {
  const links = [...document.querySelectorAll(".menu a[href^='#']")];
  if (!links.length || !("IntersectionObserver" in window)) return;

  const sectionById = new Map(
    links
      .map(link => link.getAttribute("href"))
      .filter(Boolean)
      .map(id => [id, document.querySelector(id)])
      .filter(([, section]) => !!section)
  );

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const id = `#${entry.target.id}`;
      links.forEach(link => {
        link.classList.toggle("active-link", link.getAttribute("href") === id);
      });
    });
  }, { threshold: 0.3 });

  sectionById.forEach(section => observer.observe(section));
}

window.addEventListener("DOMContentLoaded", () => {
  runTypingLoop();
  activateMenuHighlights();
});
