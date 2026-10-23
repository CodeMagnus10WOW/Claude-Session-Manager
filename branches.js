// Verlaufszweige eines Transkripts. Jeder Eintrag zeigt per parentUuid auf seinen Vorgänger.
// Schreiben zwei Programme in dieselbe Session oder springt jemand in der Claude-App zurück,
// hängen an einem Eintrag zwei Fortsetzungen. Aktiv ist der Zweig mit dem zuletzt
// geschriebenen Prompt bzw. der zuletzt geschriebenen Antwort; die anderen gelten als abgehängt.
//
// Nicht jede Verzweigung ist eine Aufspaltung: Bei parallelen Tool-Aufrufen wird eine Antwort
// auf mehrere Zeilen verteilt, jedes tool_result hängt an seinem eigenen tool_use, und der Verlauf
// geht mal am ersten, mal am letzten tool_result weiter. Systemeinträge (etwa away_summary) hängen
// sich manchmal an ältere Einträge. Abgehängt ist ein Zweig deshalb nur, wenn er weder ein
// tool_result noch ein weiterer Teil derselben Antwort ist und eine Antwort von Claude enthält.
//
//   node branches.js   -> Selbsttest

// Baum, den parseSession nebenbei mitführt: uuid -> { parent, tr, asst }, in Dateireihenfolge.
// tr = Eintrag ist ein tool_result, asst = Eintrag ist eine Antwort von Claude, msg = deren API-Nachricht.
function treeNode(o) {
  const content = o.message && o.message.content;
  return {
    parent: o.parentUuid || o.logicalParentUuid || null, // nach dem Komprimieren zeigt logicalParentUuid auf den Vorgänger
    tr: o.type === "user" && Array.isArray(content) && content.some(c => c && c.type === "tool_result"),
    asst: o.type === "assistant",
    msg: (o.type === "assistant" && o.message && o.message.id) || null,
  };
}

// Liefert die abgehängten Einträge, die Stellen, an denen sich der Verlauf aufspaltet,
// und eine Signatur, an der sich erkennen lässt, ob sich daran etwas geändert hat.
function deadBranches(nodes, leaf) {
  const onPath = new Set();
  for (let u = leaf; u && nodes.has(u) && !onPath.has(u); u = nodes.get(u).parent) onPath.add(u);

  // Enthält der Teilbaum ab diesem Eintrag eine Antwort von Claude? Kinder stehen in der
  // Datei hinter ihren Eltern, rückwärts gelesen reicht deshalb ein Durchlauf.
  const withAnswer = new Set();
  const order = [...nodes.keys()];
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i], n = nodes.get(u);
    if (n.asst || withAnswer.has(u)) { withAnswer.add(u); if (n.parent) withAnswer.add(n.parent); }
  }

  const dead = new Set(), forks = new Set();
  for (const u of order) {
    const n = nodes.get(u);
    if (dead.has(n.parent)) dead.add(u);
    else if (!onPath.has(u) && onPath.has(n.parent) && !n.tr && withAnswer.has(u) && !(n.msg && nodes.get(n.parent).msg === n.msg)) {
      dead.add(u); forks.add(n.parent);
    }
  }
  return { dead, forks, sig: [...dead].filter(u => !dead.has(nodes.get(u).parent)).join(",") };
}

module.exports = { treeNode, deadBranches };

if (require.main === module) {
  const assert = require("assert");
  const build = entries => new Map(entries.map(([u, parent, type, tr, id]) =>
    [u, treeNode({ parentUuid: parent, type, message: { id, content: tr ? [{ type: "tool_result" }] : "x" } })]));

  // Linearer Verlauf: nichts abgehängt
  let r = deadBranches(build([["a", null, "user"], ["b", "a", "assistant"], ["c", "b", "user"]]), "c");
  assert.strictEqual(r.dead.size, 0);

  // Zwei parallele Tool-Aufrufe: das erste tool_result hängt neben dem zweiten tool_use, keine Aufspaltung
  r = deadBranches(build([["a", null, "user"], ["t1", "a", "assistant"], ["t2", "t1", "assistant"],
    ["r1", "t1", "user", true], ["r2", "t2", "user", true], ["b", "r2", "assistant"]]), "b");
  assert.strictEqual(r.dead.size, 0);

  // Eine Antwort mit zwei tool_use-Zeilen, der Verlauf geht am ersten tool_result weiter: keine Aufspaltung
  r = deadBranches(build([["a", null, "user"], ["t1", "a", "assistant", false, "m1"], ["t2", "t1", "assistant", false, "m1"],
    ["r2", "t2", "user", true], ["r1", "t1", "user", true], ["b", "r1", "assistant", false, "m2"]]), "b");
  assert.strictEqual(r.dead.size, 0);

  // Systemeintrag hängt an einem älteren Eintrag, der Prompt daneben bekam keine Antwort: keine Aufspaltung
  r = deadBranches(build([["a", null, "user"], ["b", "a", "assistant"], ["p", "b", "user"],
    ["s", "b", "system"], ["q", "s", "user"], ["c", "q", "assistant"]]), "c");
  assert.strictEqual(r.dead.size, 0);

  // Zwei Programme setzen an "b" fort: der ältere Zweig samt Nachfolgern ist abgehängt
  r = deadBranches(build([["a", null, "user"], ["b", "a", "assistant"], ["x1", "b", "user"], ["x2", "x1", "assistant"],
    ["x3", "x2", "user", true], ["y1", "b", "user"], ["y2", "y1", "assistant"]]), "y2");
  assert.deepStrictEqual([...r.dead], ["x1", "x2", "x3"]);
  assert.deepStrictEqual([...r.forks], ["b"]);
  assert.strictEqual(r.sig, "x1");

  // Schreibt danach wieder das andere Programm, wird dessen Zweig aktiv
  r = deadBranches(build([["a", null, "user"], ["b", "a", "assistant"], ["x1", "b", "user"], ["x2", "x1", "assistant"],
    ["y1", "b", "user"], ["y2", "y1", "assistant"], ["x4", "x2", "user"]]), "x4");
  assert.deepStrictEqual([...r.dead], ["y1", "y2"]);

  console.log("branches.js: alle Prüfungen bestanden");
}
