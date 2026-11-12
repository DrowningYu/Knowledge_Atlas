import React from 'react';
import {createRoot} from 'react-dom/client';
import {TunnelSettings} from '../src/TunnelSettings';
import '../src/style.css';
createRoot(document.getElementById('root')!).render(<div className="modal" style={{margin:'24px auto'}}><TunnelSettings/></div>);
