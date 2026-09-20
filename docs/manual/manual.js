const contents = document.querySelector('#contents-disclosure');
const compact = window.matchMedia('(max-width: 700px)');
function syncContents() {
  if (contents) contents.open = !compact.matches;
}
syncContents();
compact.addEventListener('change', syncContents);
