// 40 FICTIONAL broker notes with expected labels, used to score the parser (Test 3)
// until Trivium's real notes arrive. Replace with real notes via the Admin → Parse test screen
// (paste JSON or one note per line). Expected values: null = should be left empty / flagged.
// All notes dated 2026-10-01.
export const SAMPLE_NOTES = [
  ['Spoke w/ Marcus, not looking to sell right now. f/u 3/15', 'Marcus', 'spoke', '2027-03-15', 'none', false],
  ['LM for Ruth Stein re: valuation', 'Ruth Stein', 'left message', null, 'none', false],
  ['NA. tried Dov twice', 'Dov', 'no answer', null, 'none', false],
  ['Met Saul at the bldg, walked all 24 units. Says he would sell if number is right. Send BOV, f/u in 2 weeks', 'Saul', 'met in person', '2026-10-15', 'selling interest', false],
  ['Emailed Leah the Elizabeth comps', 'Leah', 'email', null, 'none', false],
  ['Got Victor on the phone — loan coming due next yr, talking to lenders about a refi. cb in Jan', 'Victor', 'spoke', '2027-01-01', 'refinancing', false],
  ['Spoke to Hannah Gold. She said DO NOT CALL again, very annoyed.', 'Hannah Gold', 'spoke', null, 'none', true],
  ['vm left w/ Isaac Rubin', 'Isaac Rubin', 'left message', null, 'none', false],
  ['Talked to Pablo, wants to 1031 into something bigger in Bergen. f/u 11/5', 'Pablo', 'spoke', '2026-11-05', '1031 exchange', false],
  ['no pickup Esther', 'Esther', 'no answer', null, 'none', false],
  ['Sat down with Raymond Klein at his office. Not selling, happy holding. Too soon to push, give it a few months', 'Raymond Klein', 'met in person', null, 'none', true],
  ['emailed Theodore BOV, he replied thanks', 'Theodore', 'email', null, 'none', false],
  ['Spoke w/ Clara — son runs the bldgs now, call him instead (Daniel)', 'Clara', 'spoke', null, 'none', false],
  ['LM. Owner Ezra Halpern. f/u 10/20', 'Ezra Halpern', 'left message', '2026-10-20', 'none', false],
  ['Spoke w/ Nathan, might sell next year after the estate settles', 'Nathan', 'spoke', null, 'selling interest', false],
  ['Called Gloria, hung up on me', 'Gloria', 'spoke', null, 'none', true],
  ['Met Felix + his attorney re: possible sale of the Plainfield portfolio. Wants offers by EOM', 'Felix', 'met in person', null, 'selling interest', false],
  ['NA x3 for Moshe. Try again in a month', 'Moshe', 'no answer', '2026-11-01', 'none', false],
  ['spoke to Rebecca, loan matures Q2, open to refi or sale', 'Rebecca', 'spoke', null, 'refinancing', false],
  ['sent Samuel an email w/ rent roll request', 'Samuel', 'email', null, 'none', false],
  ['Left voicemail for Judith', 'Judith', 'left message', null, 'none', false],
  ['Spoke with Bernard — take him off the list, not interested ever', 'Bernard', 'spoke', null, 'none', true],
  ['Walked the building with Oscar. Big capex coming (roof, boilers). Thinking about selling. f/u 12/1', 'Oscar', 'met in person', '2026-12-01', 'selling interest', false],
  ['LM Tamar', 'Tamar', 'left message', null, 'none', false],
  ['Talked to Kenneth re 1031 replacement, needs to close by March', 'Kenneth', 'spoke', null, '1031 exchange', false],
  ['Spoke w/ Ana, just touching base. f/u after the holidays', 'Ana', 'spoke', null, 'none', false],
  ['No answer, mailbox full (Simon Weiss)', 'Simon Weiss', 'no answer', null, 'none', false],
  ['Emailed Harold re refinance options, loan due 2027', 'Harold', 'email', null, 'refinancing', false],
  ['Met Lucia for coffee. Partner dispute, may force a sale. Sensitive — back off until she calls', 'Lucia', 'met in person', null, 'selling interest', true],
  ['spk w/ Walter, not selling. f/u in 6 months', 'Walter', 'spoke', '2027-04-01', 'none', false],
  ['LM for the super, owner is Aaron Katz', 'Aaron Katz', 'left message', null, 'none', false],
  ['Talked to Miriam — already listed with another broker', 'Miriam', 'spoke', null, 'selling interest', false],
  ['Got Zev on phone, rate resetting next spring, wants to discuss refi. f/u 4/1', 'Zev', 'spoke', '2027-04-01', 'refinancing', false],
  ['emailed Carla', 'Carla', 'email', null, 'none', false],
  ['NA', null, 'no answer', null, 'none', false],
  ['Spoke with Yosef Levin. Interested in 1031 out of his Newark 6-family into larger asset. Call back 10/9', 'Yosef Levin', 'spoke', '2026-10-09', '1031 exchange', false],
  ['Left msg w/ assistant for Stanley', 'Stanley', 'left message', null, 'none', false],
  ['Met Patricia at property, toured vacant units. No interest in selling', 'Patricia', 'met in person', null, 'none', false],
  ['Called Eduardo, he said call him next quarter', 'Eduardo', 'spoke', null, 'none', false],
  ['Spoke to Deborah. Asked us to stop calling, she will reach out if anything changes', 'Deborah', 'spoke', null, 'none', true],
].map(([text, name, outcome, followUp, signal, cooldown], i) => ({ i, text, date: '2026-10-01', expected: { contact_name: name, outcome, follow_up_date: followUp, deal_signal: signal, cooldown } }));

export function scoreParse(notes, results) {
  const fields = ['contact_name', 'outcome', 'follow_up_date', 'deal_signal', 'cooldown'];
  const tally = Object.fromEntries(fields.map(f => [f, 0])); const rows = [];
  notes.forEach((n, i) => {
    const r = results[i] || {}; const e = n.expected; if (!e) return;
    const ok = {};
    for (const f of fields) {
      let good = f === 'contact_name' ? (!e[f] ? !r[f] || (r.uncertain || []).includes(f) : (r[f] || '').toLowerCase().includes(e[f].split(' ')[0].toLowerCase()))
        : f === 'follow_up_date' ? (r[f] === e[f] || (!e[f] && !r[f]) || (!e[f] && (r.uncertain || []).includes(f)))
        : r[f] === e[f];
      if (!good && f !== 'cooldown' && f !== 'deal_signal' && (r.uncertain || []).includes(f)) good = 'flagged';
      ok[f] = good; if (good === true) tally[f]++;
    }
    rows.push({ i, ok });
  });
  const n = rows.length;
  const pct = Object.fromEntries(fields.map(f => [f, Math.round(100 * tally[f] / n)]));
  const flagged = rows.filter(r => Object.values(r.ok).includes('flagged')).length;
  return { n, pct, flagged, rows };
}
