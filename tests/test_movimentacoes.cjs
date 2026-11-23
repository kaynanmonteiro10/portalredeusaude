const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../movimentacoes.js');

const config = () => ({ company: '462', date: '2026-11-17', comment: 'Rescisão de contrato' });
const person = (code = '01001', cpf = '52998224725', name = 'Ana') => ({ fields: [code, cpf, name], line: 1, selected: true });

test('validates CPF digits, formatting and check digits', () => {
  for (const cpf of ['52998224725', '529.982.247-25', '11144477735', '01234567890']) assert.equal(m.validCpf(cpf), true);
  for (const cpf of ['', '1111111111', '11111111111', '52998224724', 'CPF52998224725', '+52998224725']) assert.equal(m.validCpf(cpf), false);
});

test('dates require a real calendar date and preserve day/month', () => {
  assert.equal(m.isoDate('29/02/2024'), '2024-02-29');
  assert.equal(m.isoDate('29/02/2025'), '');
  assert.equal(m.isoDate('2026-13-01'), '');
  assert.equal(m.isoDate('31/04/2026'), '');
  assert.equal(m.brDate('2026-11-17'), '17/11/2026');
});

test('bulk list accepts optional header, blank rows and 2 or 3 columns without auto-selecting', () => {
  const rows = m.loadCancellations('CODIGO VIDA;CPF;NOME\r\n00123;52998224725;Pessoa\r\n\r\n124;11144477735\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fields[0], '00123');
  assert.equal(rows[0].fields[2], 'Pessoa');
  assert.equal(rows[1].fields[2], '');
  assert.ok(rows.every(row => row.selected === false));
});

test('malformed bulk lists are rejected with the offending line', () => {
  assert.throws(() => m.loadCancellations('52998224725'), /CODIGO VIDA/);
  assert.throws(() => m.loadCancellations('123;52998224725;Nome;extra'), /Linha 1/);
  assert.throws(() => m.loadCancellations('123;52998224725;Pessoa\n124'), /Linha 2/);
});

test('handles BOM, CRLF, escaped quotes and semicolons inside quoted cells', () => {
  const rows = m.loadCancellations('\uFEFFCODIGO VIDA;CPF;NOME\r\n123;52998224725;"Silva; ""Ana"""\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields[2], 'Silva; "Ana"');
});

test('rejects truncated quotes, bare quotes and text after a closing quote', () => {
  for (const source of ['"ab', 'ab"cd;ef', '"abc"x;def']) assert.throws(() => m.parseCsv(source));
});

test('cancellation configuration requires company, date up to today and comment', () => {
  const rows = [person()];
  for (const [name, value] of [['company', ''], ['company', 'Empresa 462'], ['date', ''], ['date', '31/02/2026'], ['date', '2026-11-18'], ['comment', ''], ['comment', '   ']]) {
    const cfg = config(); cfg[name] = value;
    assert.ok(m.validate(rows, cfg, '2026-11-17').configErrors.length, `${name}=${value}`);
    assert.throws(() => m.exportFile(rows, cfg));
  }
  assert.equal(m.validate(rows, config(), '2026-11-17').configErrors.length, 0);
});

test('comment length and unsafe configuration text are blocked', () => {
  const cfg = config(); cfg.comment = 'a'.repeat(501);
  assert.match(m.validate([person()], cfg).configErrors.join(' '), /500/);
  cfg.comment = '=HYPERLINK("x")';
  assert.match(m.validate([person()], cfg).configErrors.join(' '), /fórmulas/);
  cfg.comment = 'linha\nquebrada';
  assert.match(m.validate([person()], cfg).configErrors.join(' '), /controle/);
  cfg.comment = 'Motivo 漢';
  assert.match(m.validate([person()], cfg).configErrors.join(' '), /Windows-1252/);
});

test('each person needs a numeric life code and a valid CPF', () => {
  const cases = [['', '52998224725'], ['contrato', '52998224725'], ['0', '52998224725'], ['123', ''], ['123', '11111111111'], ['123', '529.982.247-24']];
  for (const [code, cpf] of cases) {
    const result = m.validate([person(code, cpf)], config());
    assert.ok(result.items[0].errors.length, `${code}/${cpf}`);
    assert.equal(result.validCount, 0);
  }
});

test('duplicate life codes and CPFs block every ambiguous occurrence', () => {
  const byCode = m.loadCancellations('123;52998224725;Um\n0123;11144477735;Dois');
  const codeResult = m.validate(byCode, config());
  assert.equal(codeResult.validCount, 0);
  assert.ok(codeResult.items.every(row => row.errors.includes('Código da vida repetido na lista.')));

  const byCpf = m.loadCancellations('123;52998224725;Um\n124;529.982.247-25;Dois');
  const cpfResult = m.validate(byCpf, config());
  assert.equal(cpfResult.validCount, 0);
  assert.ok(cpfResult.items.every(row => row.errors.includes('CPF repetido na lista.')));
});

test('spreadsheet formulas, control characters and unsupported text are blocked per column', () => {
  for (const value of ['=HYPERLINK("x")', '+SUM(1)', '-CMD', '@formula', 'Pessoa\u0000teste', 'Pessoa 漢', 'Pessoa 😀']) {
    for (const index of [0, 2]) {
      const row = person(); row.fields[index] = value;
      assert.ok(m.validate([row], config()).items[0].errors.length, `${index}:${value}`);
    }
  }
});

test('export requires deliberate selection and skips unselected rows with issues', () => {
  const valid = person(); valid.selected = false;
  assert.throws(() => m.exportFile([valid], config()), /Selecione/);
  valid.selected = true;
  const invalid = person('01002', '11111111111', 'Inválida'); invalid.selected = false;
  assert.equal(m.exportFile([valid, invalid], config()).count, 1);
  invalid.selected = true;
  assert.throws(() => m.exportFile([valid, invalid], config()), /pendências/);
});

test('export builds the review report with company, date and normalized CPF', () => {
  const row = person('01001', '529.982.247-25', 'Ana');
  const output = m.exportFile([row], config());
  const parsed = m.parseCsv(output.text);
  assert.deepEqual(parsed[0].fields, ['CODIGO VIDA', 'CPF', 'NOME', 'CODIGO EMPRESA', 'DATA CANCELAMENTO', 'COMENTARIO']);
  assert.deepEqual(parsed[1].fields, ['01001', '52998224725', 'Ana', '462', '17/11/2026', 'Rescisão de contrato']);
  assert.equal(output.count, 1);
  assert.equal(new TextDecoder('windows-1252').decode(output.bytes), output.text);
});

test('optional name is exported empty instead of invalidating the person', () => {
  const output = m.exportFile([person('01001', '52998224725', '')], config());
  assert.equal(m.parseCsv(output.text)[1].fields[2], '');
});

test('Windows-1252 preserves accents and rejects unsupported text', () => {
  const text = 'Mãe;Nº;Rescisão;€';
  assert.equal(new TextDecoder('windows-1252').decode(m.encode1252(text)), text);
  assert.throws(() => m.encode1252('漢'));
});

test('large lists are bounded', () => {
  assert.throws(() => m.parseCsv('a;b\n'.repeat(5026)), /5\.000/);
  assert.throws(() => m.loadCancellations('123;52998224725;Pessoa\n'.repeat(5001)), /5\.000/);
});
