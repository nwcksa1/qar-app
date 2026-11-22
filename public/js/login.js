/* Login bootstrap — portal comes from <body data-portal="admin|user"> (CSP: no inline scripts). */
(function () { 'use strict'; window.QAR.initLogin(document.body.dataset.portal === 'admin' ? 'admin' : 'user'); })();
