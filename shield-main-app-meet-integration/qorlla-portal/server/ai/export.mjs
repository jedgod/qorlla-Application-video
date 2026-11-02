// Report exports (PDF via pdfkit, DOCX via docx). Only ever called after the route has authorised the viewer; the transcript is
// included only when the caller was separately allowed to see it.
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
export const exportModel = ({ report, items, transcript }) => ({
  title: report.title,
  meta: `Generated ${day(report.created_at)} by ${report.generated_by || 'AI'} - speaker names are labels typed by participants and are not verified identities. AI output can be wrong: check it before relying on it.`,
  summary: report.summary, decisions: report.decisions || [], topics: report.topics || [],
  items: items.map((i) => ({ title: i.title, status: i.status, owner: i.owner_label || i.owner_hint || '', due: i.due_at ? day(i.due_at) : (i.due_hint || '') })),
  transcript: transcript ? transcript.segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)) : null
});

export function toPdf(model) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, info: { Title: model.title, Producer: 'Qorlla Workplace' }, compress: process.env.REPORT_PDF_COMPRESS !== 'false' });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(20).text(model.title); doc.moveDown(0.3).fontSize(8).fillColor('#555').text(model.meta).fillColor('#000');
    const h = (t) => { doc.moveDown().fontSize(13).text(t, { underline: false }).moveDown(0.2).fontSize(10.5); };
    h('Summary'); doc.text(model.summary);
    if (model.decisions.length) { h('Decisions'); model.decisions.forEach((d) => doc.text('- ' + d)); }
    if (model.topics.length) { h('Topics'); doc.text(model.topics.join(', ')); }
    h('Action items'); if (!model.items.length) doc.text('None recorded.');
    model.items.forEach((i) => doc.text(`[${i.status === 'done' ? 'x' : ' '}] ${i.title}${i.owner ? '  - ' + i.owner : ''}${i.due ? '  - due ' + i.due : ''}`));
    if (model.transcript) { h('Transcript'); model.transcript.forEach((l) => doc.fontSize(9).text(l)); }
    doc.end();
  });
}

export async function toDocx(model) {
  const p = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })] });
  const heading = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 });
  const children = [new Paragraph({ text: model.title, heading: HeadingLevel.TITLE }), p(model.meta, { italics: true, size: 16 }), heading('Summary'), p(model.summary)];
  if (model.decisions.length) children.push(heading('Decisions'), ...model.decisions.map((d) => new Paragraph({ text: d, bullet: { level: 0 } })));
  if (model.topics.length) children.push(heading('Topics'), p(model.topics.join(', ')));
  children.push(heading('Action items'));
  if (!model.items.length) children.push(p('None recorded.'));
  model.items.forEach((i) => children.push(p(`[${i.status === 'done' ? 'x' : ' '}] ${i.title}${i.owner ? ' - ' + i.owner : ''}${i.due ? ' - due ' + i.due : ''}`)));
  if (model.transcript) children.push(heading('Transcript'), ...model.transcript.map((l) => p(l, { size: 18 })));
  return Packer.toBuffer(new Document({ creator: 'Qorlla Workplace', title: model.title, sections: [{ children }] }));
}
