import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <div className="app">
      <header className="topbar">
        <h1>Helvarix Advanced Fabricator</h1>
        <div>Credits: 184</div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <h3>Parameters</h3>
          <label>Length</label>
          <input type="number" defaultValue={1200} />

          <label>Diameter</label>
          <input type="number" defaultValue={300} />

          <button>GENERATE</button>
        </aside>

        <main className="viewport">
          <div className="grid-room">
            <div className="object" />
          </div>
        </main>

        <aside className="sidebar">
          <h3>Results</h3>
          <p>Status: READY</p>
        </aside>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
