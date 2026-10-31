// Measures horizontal overflow so a failing layout assertion reports WHAT overflowed and by how much, not just "false".
// The assertions that use it keep their exact condition (scrollWidth <= clientWidth, or <= innerWidth); only the failure message gains these numbers.
async function measureOverflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement, w = window.innerWidth;
    const offenders = [...document.querySelectorAll('body *')].map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.right > w + 0.5 || r.left < -0.5))
      .sort((a, b) => b.r.right - a.r.right).slice(0, 8)
      .map(({ e, r }) => ({ el: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : ''), left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, text: (e.children.length ? '' : (e.textContent || '').trim().slice(0, 40)) }));
    return { url: location.pathname, innerWidth: w, clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth, dpr: window.devicePixelRatio, bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 80), lang: de.lang, offenders };
  });
}
module.exports = { measureOverflow };
