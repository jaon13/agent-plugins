import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/layout.css';
import './styles/components.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (target) {
  mount(App, { target });
}
