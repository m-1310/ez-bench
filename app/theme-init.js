try { document.documentElement.dataset.theme=localStorage.getItem('work-ez-bench.theme')==='light'?'light':'dark'; }
catch { document.documentElement.dataset.theme='dark'; }
