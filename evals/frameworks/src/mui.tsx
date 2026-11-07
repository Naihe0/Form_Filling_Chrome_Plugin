// A plain Material UI form with controlled state mirrored to window.__values.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Autocomplete, Box, Button, Checkbox, FormControl, FormControlLabel, FormGroup, FormLabel,
  InputLabel, MenuItem, Radio, RadioGroup, Select, TextField,
} from '@mui/material';

const COUNTRIES = ['Canada', 'China', 'Chile', 'France', 'Germany', 'Japan', 'United Kingdom', 'United States'];
const SKILLS = ['JavaScript', 'Python', 'Go', 'Rust'];

function App() {
  const [values, setValues] = useState<any>({ name: '', email: '', gender: '', degree: '', country: null, skills: [], bio: '' });
  const set = (key: string) => (value: unknown) => setValues((all: any) => ({ ...all, [key]: value }));
  useEffect(() => {
    (window as any).__values = values;
  }, [values]);

  return (
    <Box component="form" sx={{ maxWidth: 520, m: 3, display: 'flex', flexDirection: 'column', gap: 2 }}
      onSubmit={(event) => { event.preventDefault(); (window as any).__submitted = true; }}>
      <TextField label="Full name" value={values.name} onChange={(e) => set('name')(e.target.value)} />
      <TextField label="Email" type="email" value={values.email} onChange={(e) => set('email')(e.target.value)} />
      <FormControl>
        <FormLabel id="gender-label">Gender</FormLabel>
        <RadioGroup aria-labelledby="gender-label" value={values.gender} onChange={(e) => set('gender')(e.target.value)}>
          <FormControlLabel value="male" control={<Radio />} label="Male" />
          <FormControlLabel value="female" control={<Radio />} label="Female" />
        </RadioGroup>
      </FormControl>
      <FormControl fullWidth>
        <InputLabel id="degree-label">Highest degree</InputLabel>
        <Select labelId="degree-label" label="Highest degree" value={values.degree} onChange={(e) => set('degree')(e.target.value)}>
          <MenuItem value="bachelor">Bachelor</MenuItem>
          <MenuItem value="master">Master</MenuItem>
          <MenuItem value="doctor">Doctorate</MenuItem>
        </Select>
      </FormControl>
      <Autocomplete
        options={COUNTRIES}
        value={values.country}
        onChange={(_e, value) => set('country')(value)}
        renderInput={(params) => <TextField {...params} label="Country of residence" />}
      />
      <FormControl component="fieldset">
        <FormLabel component="legend">Programming languages</FormLabel>
        <FormGroup>
          {SKILLS.map((skill) => (
            <FormControlLabel key={skill} label={skill} control={
              <Checkbox
                checked={values.skills.includes(skill)}
                onChange={(e) =>
                  setValues((all: any) => ({
                    ...all,
                    skills: e.target.checked ? [...all.skills, skill] : all.skills.filter((s: string) => s !== skill),
                  }))
                }
              />
            } />
          ))}
        </FormGroup>
      </FormControl>
      <TextField label="Short bio" multiline minRows={2} value={values.bio} onChange={(e) => set('bio')(e.target.value)} />
      <Button type="submit" variant="contained">Submit</Button>
    </Box>
  );
}

(window as any).__values = {};
(window as any).__submitted = false;
createRoot(document.getElementById('root')!).render(<App />);
