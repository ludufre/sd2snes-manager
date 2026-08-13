import { Routes } from '@angular/router';
import { Library } from './features/library/library';

// Single screen. `folder` and `game` ride as query params (Back/Forward nav).
export const routes: Routes = [
  { path: '', component: Library, title: 'sd2snes+ Manager' },
  { path: '**', redirectTo: '' },
];
