const fs=require('fs');
const dir='evidence/history-compact';
let html=fs.readFileSync(dir+'/original.html','utf8');
function replace(before,after){if(!html.includes(before))throw Error('Missing history anchor: '+before.slice(0,80));html=html.replace(before,after);}
replace("var split = true, PAGE = 5, wide", "var split = true, PAGE = Math.max(5, Math.min(16, Math.floor((window.innerHeight - 300) / 71))), wide");
replace("d.meetings.forEach(function (b) { list.appendChild(histRow(b, reload, collapseOthers)); });", "list.style.setProperty('--history-page-size', String(PAGE));\n        list.style.setProperty('--history-list-height', Math.max(440, window.innerHeight - list.getBoundingClientRect().top - 28) + 'px');\n        d.meetings.forEach(function (b, index) { var row = histRow(b, reload, collapseOthers); row.style.setProperty('--history-row', String(index + 1)); list.appendChild(row); });");
replace("pager.classList.toggle('hidden', total <= PAGE);", "pager.classList.remove('hidden'); prev.setAttribute('aria-label', I18n.t('Previous page')); next.setAttribute('aria-label', I18n.t('Next page')); ");
replace("var mine = ++seq, qs", "prev.disabled = true; next.disabled = true; list.setAttribute('aria-busy', 'true');\n      var mine = ++seq, qs");
replace("if (mine !== seq) return; total = d.total;", "if (mine !== seq) return; list.setAttribute('aria-busy', 'false'); total = d.total;");
replace("if (mine !== seq) return; list.textContent = '';", "if (mine !== seq) return; list.setAttribute('aria-busy', 'false'); list.textContent = '';");
replace('</head>', '<style id="history-compact-layout">\n'+fs.readFileSync('scripts/history-compact.css','utf8')+'\n</style>\n</head>');
fs.writeFileSync(dir+'/candidate.html',html);
console.log('Prepared compact history layout and viewport-sized pagination.');
