import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://ivdtkwovtxtwnfnljvxc.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2ZHRrd292dHh0d25mbmpsdnhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEyMzE3NDksImV4cCI6MjA1NjgwNjc0OX0.dummykey';

export const supabase = createClient(supabaseUrl, supabaseKey);
