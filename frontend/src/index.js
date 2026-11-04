import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";

import { BrowserRouter } from "react-router-dom";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          {process.env.REACT_APP_DEMO_MODE === 'true' && (
            <div role="status" style={{position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 10000, padding: '8px 16px', background: '#fef3c7', color: '#78350f', textAlign: 'center', fontSize: 13}}>
              Local demo · Accounts, files and chats reset on restart. Use sample files only.
            </div>
          )}
          <App />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
