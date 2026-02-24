import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// 家計簿と同じFirebaseプロジェクトを使用
const firebaseConfig = {
  apiKey: "AIzaSyCgBbWNDIB0CdueKomyarA2yzZASO4o_oA",
  authDomain: "kakeibo-2e6a5.firebaseapp.com",
  projectId: "kakeibo-2e6a5",
  storageBucket: "kakeibo-2e6a5.firebasestorage.app",
  messagingSenderId: "688285830645",
  appId: "1:688285830645:web:0a87ea4123b8b2746a64bc"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
