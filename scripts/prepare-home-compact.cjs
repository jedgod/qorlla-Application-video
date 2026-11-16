const fs=require('fs');const dir='evidence/home-compact';let html=fs.readFileSync(dir+'/original.html','utf8');const css=`
/* Compact workspace greeting and five primary actions. */
body[data-page=workspace] .home-heading { gap:12px; padding-bottom:12px; align-items:center; }
body[data-page=workspace] .home-heading h1.greeting { font-size:clamp(21px,2vw,27px); line-height:1.2; letter-spacing:-.6px; margin:0; }
body[data-page=workspace] .home-heading .product-eyebrow { display:none; }
body[data-page=workspace] .home-heading .home-subtitle { font-size:12px; line-height:1.4; margin:5px 0 0; }
body[data-page=workspace] .home-clock .time { font-size:25px; line-height:1.1; }
body[data-page=workspace] .home-clock .date { font-size:11px; margin-top:4px; }
body[data-page=workspace] .home-heading + .actions { grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin:14px 0 18px; }
body[data-page=workspace] .home-heading + .actions .action-btn { flex-direction:row; justify-content:center; min-height:56px; padding:9px 10px; gap:9px; border-radius:10px; box-sizing:border-box; }
body[data-page=workspace] .home-heading + .actions .action-icon { width:32px; height:32px; flex-shrink:0; border-radius:9px; }
body[data-page=workspace] .home-heading + .actions .action-icon svg.i { width:19px; height:19px; }
body[data-page=workspace] .home-heading + .actions .action-btn span { font-size:12px; }
@media(max-width:600px) {
 body[data-page=workspace] .home-heading { flex-direction:row; align-items:flex-start; }
 body[data-page=workspace] .home-clock { display:block; text-align:right; }
 body[data-page=workspace] .home-clock .time { font-size:20px; }
 body[data-page=workspace] .home-heading + .actions { grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
 body[data-page=workspace] .home-heading + .actions .action-btn { flex-direction:column; gap:5px; padding:8px 4px; min-height:70px; }
 body[data-page=workspace] .home-heading + .actions .action-btn span { font-size:11px; }
}
`;
html=html.replace('</head>','<style id="home-compact-layout">'+css+'</style></head>');fs.writeFileSync(dir+'/candidate.html',html);
