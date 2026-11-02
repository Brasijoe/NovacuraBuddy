function escapeForTemplateLiteral(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}
const ITERATE_BLOCK_RE = /<iterate\s+([^>]*)>([\s\S]*?)<\/iterate>/g;
const COLUMN_TOKEN_RE = /@([A-Za-z_][A-Za-z0-9_]*)/g;
function extractAttr(attrsText, name) {
  const m = attrsText.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}
function rewriteIterateBlocks(html) {
  return html.replace(ITERATE_BLOCK_RE, (whole, attrsText, rowTemplate) => {
    const table = extractAttr(attrsText, "table");
    if (!table) return whole;
    const row = escapeForTemplateLiteral(rowTemplate).replace(COLUMN_TOKEN_RE, (_m, col) => `{row.${col}}`);
    return `{join((${table}).map(row => \`${row}\`), "")}`;
  });
}
function buildHtmlTemplateLiteral(rawHtml) {
  const withIterateRewritten = rewriteIterateBlocks(rawHtml);
  return escapeForTemplateLiteral(withIterateRewritten);
}
function buildHtml2PdfScript(decoded) {
  const fileNameExpr = `\`${escapeForTemplateLiteral(decoded.fileName)}\``;
  const htmlExpr = `\`${buildHtmlTemplateLiteral(decoded.html)}\``;
  const optionParts = [];
  if (decoded.stylesheet) optionParts.push(`css: ${JSON.stringify(decoded.stylesheet)}`);
  const layoutParts = [];
  if (decoded.pageSize) layoutParts.push(`pageSize: ${JSON.stringify(decoded.pageSize)}`);
  if (decoded.pageOrientation) layoutParts.push(`pageOrientation: ${JSON.stringify(decoded.pageOrientation.toLowerCase())}`);
  if (layoutParts.length > 0) optionParts.push(`layout: {${layoutParts.join(", ")}}`);
  const marginParts = [];
  if (decoded.marginTop !== null) marginParts.push(`marginTop: ${decoded.marginTop}`);
  if (decoded.marginBottom !== null) marginParts.push(`marginBottom: ${decoded.marginBottom}`);
  if (decoded.marginLeft !== null) marginParts.push(`marginLeft: ${decoded.marginLeft}`);
  if (decoded.marginRight !== null) marginParts.push(`marginRight: ${decoded.marginRight}`);
  if (marginParts.length > 0) optionParts.push(`margin: {${marginParts.join(", ")}}`);
  const optionsExpr = `{${optionParts.join(", ")}}`;
  return { script: `return FileSystem.convertHtmlToPdf(${fileNameExpr}, ${htmlExpr}, ${optionsExpr});` };
}
export {
  buildHtml2PdfScript,
  rewriteIterateBlocks
};
