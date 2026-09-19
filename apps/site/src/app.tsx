import { Download } from "./components/download";
import { Features } from "./components/features";
import { Feedback } from "./components/feedback";
import { Footer } from "./components/footer";
import { GetStarted } from "./components/get-started";
import { Hero } from "./components/hero";
import { Nav } from "./components/nav";

export const App = () => (
  <div className="min-h-screen bg-background text-foreground">
    <Nav />
    <main>
      <Hero />
      <Features />
      <GetStarted />
      <Download />
      <Feedback />
    </main>
    <Footer />
  </div>
);
