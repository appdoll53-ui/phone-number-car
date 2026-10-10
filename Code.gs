const SECRET = "поставьте-свою-длинную-строку";
const PROTOCOL = 3;

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents || "{}"); }
  catch (_) { return json({ ok: false, error: "Некорректный запрос" }); }
  if (!SECRET || body.secret !== SECRET) return json({ ok: false, error: "forbidden" });
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const book = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = book.getSheets()[0];
    ensureHeader(sheet);
    let records = readContacts(sheet);
    if (body.action === "list") return json({ ok: true, protocol: PROTOCOL, contacts: records.map(publicContact) });
    // Старые клиенты не должны возвращать удалённые контакты или обходить проверку версии.
    if (body.action !== "sync" || body.protocol !== PROTOCOL)
      return json({ ok: false, error: "Обновите приложение до версии 40 или новее на всех телефонах." });
    if (!Array.isArray(body.operations) || body.operations.length > 500)
      return json({ ok: false, error: "Слишком много изменений. Отправляйте не более 500 за один обмен." });
    let journal = book.getSheetByName("_nomera_commands");
    if (!journal) { journal = book.insertSheet("_nomera_commands"); journal.appendRow(["команда", "результат"]); }
    const receipts = new Map(journal.getDataRange().getValues().slice(1).map(r => [String(r[0]), String(r[1])]));
    const results = [];
    for (const op of body.operations) {
      if (!op || !op.opId || !op.id || !plateKey(op.plate) || !["upsert", "delete"].includes(op.type))
        throw new Error("Некорректное изменение. Очередь на телефоне сохранена.");
      if (receipts.has(op.opId)) { results.push(JSON.parse(receipts.get(op.opId))); continue; }
      let current = records.find(r => r.id === op.id);
      if (!current && op.originOpId && receipts.has(op.originOpId)) {
        const origin = JSON.parse(receipts.get(op.originOpId));
        current = records.find(r => r.id === origin.id);
      }
      if (!current && op.previousPhone) current = records.find(r => !r.deleted && plateKey(r.plate) === plateKey(op.plate) && phoneKey(r.phone) === phoneKey(op.previousPhone));
      // Восстановление после записи контакта, но до сохранения квитанции.
      if (current && current.command === op.opId) {
        const receipt = { opId: op.opId, status: "ok", id: current.id };
        saveReceipt(journal, receipts, receipt); results.push(receipt); continue;
      }
      if (op.type === "delete" && (!current || current.deleted)) {
        const receipt = { opId: op.opId, status: "ok", id: current ? current.id : op.id };
        saveReceipt(journal, receipts, receipt); results.push(receipt); continue;
      }
      const expected = op.baseRev || "";
      const legacyMatch = current && !expected && op.previousPhone && op.base && current.name === String(op.base.name || "") && phoneKey(current.phone) === phoneKey(op.base.phone);
      const ownCreationDelete = op.type === "delete" && !expected && op.originOpId && current && current.command === op.originOpId;
      if (current && (current.deleted || (!legacyMatch && !ownCreationDelete && expected !== current.rev))) {
        results.push({ opId: op.opId, status: "conflict", current: publicContact(current) }); continue;
      }
      if (!current && (expected || op.previousPhone)) {
        results.push({ opId: op.opId, status: "conflict", current: null }); continue;
      }
      if (op.type === "upsert" && !phoneKey(op.phone)) throw new Error("Пустой телефон в изменении.");
      const duplicate = op.type === "upsert" && records.find(r => !r.deleted && r.id !== (current && current.id) && plateKey(r.plate) === plateKey(op.plate) && phoneKey(r.phone) === phoneKey(op.phone));
      if (duplicate) {
        if (!current && String(op.name || "") === duplicate.name) {
          const receipt = { opId: op.opId, status: "ok", id: duplicate.id };
          saveReceipt(journal, receipts, receipt); results.push(receipt); continue;
        }
        results.push({ opId: op.opId, status: "conflict", current: publicContact(duplicate), duplicate: true }); continue;
      }
      const rowIndex = current ? current.rowIndex : sheet.getLastRow() + 1;
      const value = [op.plate, op.type === "delete" ? current.name : String(op.name || ""), op.type === "delete" ? current.phone : String(op.phone || ""), current ? current.id : op.id, current ? current.createdAt : (op.createdAt || new Date().toISOString()), (current ? current.version : 0) + 1, op.type === "delete", op.opId];
      sheet.getRange(rowIndex, 3).setNumberFormat("@");
      sheet.getRange(rowIndex, 1, 1, 8).setValues([value]);
      const saved = contactFromRow(value, rowIndex);
      if (current) records[records.indexOf(current)] = saved; else records.push(saved);
      const receipt = { opId: op.opId, status: "ok", id: saved.id };
      saveReceipt(journal, receipts, receipt); results.push(receipt);
    }
    return json({ ok: true, protocol: PROTOCOL, results, contacts: records.map(publicContact) });
  } catch (err) { return json({ ok: false, error: String(err.message || err) }); }
  finally { if (lock.hasLock()) { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } } }
}

function saveReceipt(sheet, receipts, receipt) {
  const value = JSON.stringify(receipt);
  sheet.appendRow([receipt.opId, value]); receipts.set(receipt.opId, value);
}
function plateKey(value) {
  const map = { А:"A", В:"B", Е:"E", К:"K", М:"M", Н:"H", О:"O", Р:"P", С:"C", Т:"T", У:"Y", Х:"X" };
  const key = [...String(value || "").toUpperCase()].map(c => map[c] || c).join("").replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z0-9][0-9]{3}[A-Z0-9]{2}[0-9]{2,3}$/.test(key)) return key.split("").map((c,i) => [0,4,5].includes(i) && c === "0" ? "O" : c).join("");
  return key;
}
function phoneKey(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (/^8\d{10}$/.test(digits)) digits = "7" + digits.slice(1);
  return digits;
}
function contactFromRow(r, rowIndex) {
  const contact = { plate: String(r[0] || ""), name: String(r[1] || ""), phone: String(r[2] || ""), id: String(r[3] || ""), createdAt: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || ""), version: Number(r[5]) || 1, deleted: r[6] === true || String(r[6]).toLowerCase() === "true", command: String(r[7] || ""), rowIndex };
  contact.rev = JSON.stringify([contact.version, plateKey(contact.plate), contact.name, phoneKey(contact.phone), contact.deleted]);
  return contact;
}
function publicContact(r) {
  return { id:r.id, plate:r.plate, name:r.name, phone:r.phone, rev:r.rev, deleted:r.deleted, createdAt:r.createdAt };
}
function readContacts(sheet) {
  const values = sheet.getDataRange().getValues(); const records = [];
  const ids = new Set();
  for (let i = 1; i < values.length; i++) {
    const r = values[i]; if (!plateKey(r[0]) || !phoneKey(r[2])) continue;
    if (!r[3]) { r[3] = Utilities.getUuid(); sheet.getRange(i+1,4).setValue(r[3]); }
    if (ids.has(String(r[3]))) throw new Error("В таблице повторяется ID контакта. Исправьте дубли ID перед синхронизацией.");
    ids.add(String(r[3]));
    if (!r[5]) { r[5] = 1; sheet.getRange(i+1,6).setValue(1); }
    records.push(contactFromRow(r, i+1));
  }
  return records;
}
function ensureHeader(sheet) {
  if (sheet.getLastRow() === 0) sheet.appendRow(["номер","имя","телефон","id","добавлено","версия","удалён","команда"]);
  else sheet.getRange(1,6,1,3).setValues([["версия","удалён","команда"]]);
}
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
